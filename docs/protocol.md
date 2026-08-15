# AECC local TCP protocol

This is a developer-facing description of the protocol the AECC platform speaks
over the LAN, so a contributor to this app does not have to reverse engineer it
again. It documents the same wire protocol used by
[`aecc-battery-local`](https://github.com/StekkerDeal/aecc-battery-local), the
sibling Home Assistant integration; that project's `custom_components/aecc_battery/`
source is the canonical reference if anything here goes stale.

## Transport

- Plain TCP, port 8080. No TLS, no authentication, no session token.
- **One TCP session at a time.** The battery's datalogger accepts a single open
  connection. A second client connecting does not get an error, it starves:
  both clients see slow or missing responses because the device is only
  answering one of them. Never open more than one connection to the same
  battery from this app, and be aware that the vendor app's local mode and
  the Home Assistant integration are also single-session clients competing
  for the same slot.
- Reuse one persistent connection per battery. Reconnect with backoff after a
  drop rather than opening a new socket per request.

## Message envelope

Every request is a single JSON object, written to the socket (a trailing
newline is sent but is not meaningful framing, see below):

```json
{
  "Get": "EnergyParameter",
  "SerialNumber": 1,
  "CommandSource": "Homey"
}
```

`Get` (read) or `Set` (write) names the command. `SerialNumber` is a
per-connection counter the client increments on every request; the device
does not require it to be unique across connections, just present.
`CommandSource` is a free-text client tag, not validated.

**Responses are not newline-framed.** The device does not send a trailing
delimiter, and a single response can arrive split across multiple TCP reads
(or, rarely, more than one JSON value can arrive back to back). A correct
parser accumulates bytes into a buffer and attempts `JSON.parse` after every
chunk, treating a parse failure as "not done yet" rather than an error, and
resets the buffer only once a full value has been decoded. Framing on
`json.loads` succeeding, not on any character, is the only reliable
strategy.

## Commands

| Command                   | Direction | Purpose                                                                                                                               |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `EnergyParameter`         | Get       | Live telemetry: SOC, AC/PV/backup power, per-unit `Storage_list`, system-wide `SSumInfoList`                                          |
| `Energycontrolparameters` | Get       | Read specific control registers. Request carries `RegControlAddr: [<int>, ...]`                                                       |
| `Energycontrolparameters` | Set       | Write control registers. Request carries `SetControlInfo: {"<register>": "<value>", ...}`                                             |
| `DeviceManagement`        | Get       | Read device identity/diagnostic registers. Request carries `RegDeviceManagementAddr: [<int>, ...]`. **Security-sensitive, see below** |

`EnergyParameter` responses are flat: `Storage_list` (array, one entry per
physical unit) and `SSumInfoList` (system-wide summary) sit directly on the
top-level response object, no container key.

## Response container key cascade

Both `Energycontrolparameters` and `DeviceManagement` responses wrap the
requested register values in a container object, and which key that
container is nested under is firmware- and brand-dependent. Code that reads
these responses must fall through a list of candidate keys and use the first
one present:

- `Energycontrolparameters` (Get and the Set acknowledgement): try
  `ControlInfo`, then `GetParameters`, then `Parameters`.
- `DeviceManagement`: try `DeviceManagementInfo` (seen on Sunpura), then
  `ControlInfo` (JET reuses the same key `Energycontrolparameters` uses),
  then `Parameters`, then `GetParameters`.

```
container = resp.get("ControlInfo") ?? resp.get("GetParameters") ?? resp.get("Parameters") ?? {}
```

Register keys inside the container can also arrive as either a string or an
int key (`"3003"` vs `3003`) depending on firmware; check both.

## Register map

| Register | Name                | Values                                       | Notes                                                                                                                                                         |
| -------- | ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3000     | EMS enable          | `0`/`1`                                      | Master enable. `0` does not reliably stop the battery, it hands control back to the device's own logic, so it is not used as a "stop"                         |
| 3003     | Control time slot 1 | 11-field CSV, see below                      | Primary manual power/schedule slot. Additional slots `3004`-`3018` share the same shape                                                                       |
| 3020     | Schedule mode       | `3` = self-generation, `6` = custom schedule | The device does not reset this on its own: switching back to self-consumption requires explicitly writing `3` again, or the old custom schedule keeps running |
| 3021     | AI smart charge     | `0`/`1`                                      | Set alongside `3022` to select self-consumption mode                                                                                                          |
| 3022     | AI smart discharge  | `0`/`1`                                      |                                                                                                                                                               |
| 3023     | Min discharge SOC   | percent, app range 5-50                      | Battery stops discharging at this SOC regardless of the commanded setpoint                                                                                    |
| 3024     | Max charge SOC      | percent, app range 50-100                    | Battery stops charging at this SOC regardless of the commanded setpoint                                                                                       |
| 3030     | Custom mode flag    | `0`/`1`                                      | Companion flag to `3020=6`                                                                                                                                    |
| 3039     | Max feed power      | watts                                        | Local power cap gate, see below                                                                                                                               |

### The 800W cap and register 3039

The device firmware clamps whatever power value is written to register 3003
against register 3039. Register 3039 defaults to an effective 800W, which is
the origin of the "cannot get above 800W locally" reports. Writing 3039 to a
higher value (hardware maximum 2400W) before or alongside the 3003 write
unlocks the higher range over local TCP. This app raises 3039 automatically
whenever a device setting's configured power limit exceeds 800W; a
contributor adding a new control path must do the same or setpoints above
800W will be silently clamped by the device.

This is a **different cap** from the vendor app's "On Grid Output" setting
(factory default 800W, under Operating Mode Settings), which limits what the
inverter physically delivers and is not reachable over local TCP at all. See
the Troubleshooting section of the root `README.md` for the user-facing
explanation.

### The 11-field slot string (register 3003 and 3004-3018)

```
timeSwitch,startHH:MM,endHH:MM,powerW,temp,mode,field7,field8,field9,chargingSOC,dischargingSOC
```

| #   | Field            | Notes                                                                                                                                                                                                                                                                                                   |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `timeSwitch`     | `1` = slot active, `0` = disabled                                                                                                                                                                                                                                                                       |
| 1   | `startHH:MM`     | Slot start time. A manual setpoint uses `00:00`                                                                                                                                                                                                                                                         |
| 2   | `endHH:MM`       | Slot end time. A manual setpoint uses `23:59`                                                                                                                                                                                                                                                           |
| 3   | `powerW`         | **Signed. Negative = charge, positive = discharge.** This is the raw register convention; it is the opposite sign of this app's own `target_power` capability, which follows the Homey/Energy convention of positive = charge. The app flips the sign at the boundary, once, when it builds this string |
| 4   | `temp`           | Always `0` in every capture so far                                                                                                                                                                                                                                                                      |
| 5   | `mode`           | `6` = custom schedule                                                                                                                                                                                                                                                                                   |
| 6   | `field7`         | Brand-dependent: AEG wants `0` here; other brands use `4` or `5`. Get this wrong on AEG and the write is accepted but ignored                                                                                                                                                                           |
| 7   | `field8`         | Always `0`                                                                                                                                                                                                                                                                                              |
| 8   | `field9`         | Always `0`                                                                                                                                                                                                                                                                                              |
| 9   | `chargingSOC`    | Mirrors register 3024                                                                                                                                                                                                                                                                                   |
| 10  | `dischargingSOC` | Mirrors register 3023                                                                                                                                                                                                                                                                                   |

A disabled slot is `0,00:00,00:00,0,0,0,0,0,0,100,10`, all-zero and
layout-neutral regardless of brand.

### Scaling irregularities

Field values in `EnergyParameter` responses are not consistently scaled, and
the inconsistency does not follow a simple per-field or per-device rule:

- Most fields inside a `Storage_list` entry (one object per physical unit,
  e.g. `AcChargingPower`, `BatteryChargingPower`, `BatteryDischargingPower`,
  `PvChargingPower`, `AcInActivePower`) are in **deciwatts** (divide by 10 to
  get watts).
- `Pv1Power` and `Pv2Power` inside the same `Storage_list` entry are already
  in **watts**, not deciwatts, despite living next to fields that are.
- The system-wide `SSumInfoList` summary fields (`TotalACChargePower`,
  `TotalBatteryOutputPower`, `TotalPVPower`, `MeterTotalActivePower`) are
  generally already in watts, **except** `TotalBackUpPower`, which is in
  **10W units** (confirmed against a live load: summary `183.2` against a
  storage-side `1832` under the same ~1830W load). The matching per-unit
  field `OffGridLoadPower` is in plain watts, so even the two fields
  representing the same physical quantity use different scales.
- `AverageBatteryAverageSOC` (summary) and `BatterySoc` (per-unit) are both
  already a plain percentage, no scaling.

Do not assume a field's scale from its neighbours or from another field with
a similar name; verify against a live device before trusting a new field.

## Security: DeviceManagement exposes credentials

**The `DeviceManagement` accessor is not safe to read broadly.** An
exhaustive sweep of that register space returned the device's **WiFi SSID
and password in cleartext** at registers 56 and 57, plus MAC addresses,
serial numbers and cloud endpoints.

This app reads only a fixed, deliberately narrow safe list from
`DeviceManagement`:

```
[2, 8, 9, 20, 21, 76]
```

covering device identity (serial, firmware, model) and WiFi signal strength.
**Contributors must never widen this list**, and must never log a raw,
unfiltered `DeviceManagement` response: doing either risks putting a user's
WiFi password into a log file, a diagnostics export, or a GitHub issue. If a
new field is genuinely needed from this accessor, add its specific register
number to the safe list deliberately, after checking the surrounding
registers in a fresh capture do not also change, and never add a whole
range.
