# AECC Battery (Homey)

[![Validate](https://github.com/StekkerDeal/aecc-battery-homey/actions/workflows/validate.yml/badge.svg)](https://github.com/StekkerDeal/aecc-battery-homey/actions/workflows/validate.yml)
[![GitHub release](https://img.shields.io/github/release/StekkerDeal/aecc-battery-homey.svg)](https://github.com/StekkerDeal/aecc-battery-homey/releases)
![Maintained](https://img.shields.io/badge/maintained-yes-brightgreen.svg)

A Homey app for **local TCP control** of AECC-platform plug-in home batteries: Sunpura, Lunergy, Voltdeer, AEG Solarcube, AFERIY, AccuMate, JET, Oscal and other batteries built on the same white-labelled platform. It talks directly to the battery over your LAN, no cloud round-trip, and exposes charge state, live power flow, energy totals and full charge/discharge control as Homey capabilities and flow cards.

> **Status:** Early / pre-release. The local protocol itself is proven through the sibling Home Assistant integration, [`aecc-battery-local`](https://github.com/StekkerDeal/aecc-battery-local), which has run against real batteries for months. This Homey app is a fresh implementation of the same protocol and has so far only been exercised against a single device (a JET GreenARK Pro loan unit). Expect rough edges, and please open an issue if your device does not behave as documented.

## Supported devices

Homey-specific testing so far covers only the JET GreenARK Pro, this app's development device. The other rows describe confirmation status on the Home Assistant integration, which speaks the identical protocol; compatibility with this app is expected but not yet independently confirmed on Homey for those. If you try one, please open an issue so this table can be updated.

| Brand    | Model              | Tested on Homey | Notes                                                 |
| -------- | ------------------ | --------------- | ----------------------------------------------------- |
| JET      | GreenARK Pro       | Yes             | Development device for this app                       |
| Sunpura  | S2400              | No              | Fully tested on the Home Assistant integration        |
| Lunergy  | Hub 2400 AC        | No              | Fully tested on the Home Assistant integration        |
| AEG      | Solarcube          | No              | Community confirmed on the Home Assistant integration |
| Voltdeer | SR5000             | No              | Community confirmed on the Home Assistant integration |
| AFERIY   | PS240              | No              | Community confirmed on the Home Assistant integration |
| AccuMate | Plug-In Battery    | No              | Community confirmed on the Home Assistant integration |
| Oscal    | Power Storage 2000 | No              | Community confirmed on the Home Assistant integration |

## Requirements

- Homey firmware **12.13.0** or newer (the `target_power` capability this app relies on landed in that release)
- The battery on the **same LAN** as Homey, with a **static or DHCP-reserved IP address**
- **TCP port 8080** reachable from Homey to the battery

## Installation

Install "AECC Battery" from the Homey App Store on your Homey.

For development or pre-release builds, see [`docs/development.md`](docs/development.md) for running the app via the Homey CLI instead.

## Setup

1. In the Homey app, add a device and pick **AECC Battery**.
2. Choose **Search my network** (mDNS discovery) or **Enter the IP address myself**. Discovery can miss devices across VLANs, mesh networks, or when Homey runs in a container, so manual entry is a normal choice, not a fallback.
3. Pick the battery's **brand** (or **Other** if it is not listed). This only tunes sensor-glitch filtering and an AEG-specific register quirk, it does not gate which devices can be added.
4. Homey adds the device. Open its **Settings** to adjust the port (default 8080), the poll interval (default 5 seconds, 2 second floor), and the max charge/discharge power limits (default 800W each). Read [Power limits](#power-limits) before raising those: they limit what this app commands, not what the battery is capable of.

> **Before pairing a second client, read this:** the battery only serves **one TCP connection at a time**. This app, the vendor app's local mode, and the Home Assistant integration all compete for that single slot. Running more than one of them against the same battery at once is the single most common cause of "cannot connect", see Troubleshooting below.

## Capabilities

| Capability                       | Unit | Notes                                                                                                                                                                                     |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measure_power`                  | W    | Signed: positive = charging, negative = discharging                                                                                                                                       |
| `measure_battery`                | %    | State of charge                                                                                                                                                                           |
| `battery_charging_state`         | -    | Homey's standard charging-state enum (`charging` / `discharging` / `idle`), derived from `measure_power` with a 25W deadband, so the standby draw of a stopped battery still reads `idle` |
| `meter_power.charged`            | kWh  | Locally integrated charged energy total. See Energy totals below                                                                                                                          |
| `meter_power.discharged`         | kWh  | Locally integrated discharged energy total. See Energy totals below                                                                                                                       |
| `target_power`                   | W    | Signed setpoint, -2400 to 2400: positive = charge, negative = discharge, 0 = idle. Requires Homey firmware 12.13.0 or newer                                                               |
| `target_power_mode`              | -    | `device` (Self-consumption / AI) hands control back to the battery's own logic; `homey` (Homey control) makes `target_power` authoritative                                                |
| `aecc_min_soc` (Discharge limit) | %    | Battery stops discharging at this SOC, 5-50%                                                                                                                                              |
| `aecc_max_soc` (Charge limit)    | %    | Battery stops charging at this SOC, 50-100%                                                                                                                                               |
| `aecc_last_update`               | -    | Timestamp string of the last successful poll                                                                                                                                              |
| `button.reset_meters`            | -    | Maintenance action. Resets both energy meters to zero; breaks this device's Homey Energy history continuity                                                                               |

### Energy totals

`meter_power.charged` and `meter_power.discharged` are integrated locally by this app from the live `measure_power` signal, because the local protocol exposes no cumulative energy counters at all. They will **not** exactly match the equivalent sensors in the Home Assistant integration, which integrates a different pair of signals from the same battery. This is a deliberate choice, not a bug: integrating the one signed power value this app already polls keeps the Homey Energy animation and these two meters internally consistent with each other, at the cost of them drifting slightly from a differently-computed total elsewhere.

## Control

`target_power` is the capability to use for manual control: a single signed number, positive charges, negative discharges, 0 W idles. Setting it to 0 holds an active zero-watt setpoint, which is how you stop the battery, there is no separate "off" state. `target_power` only takes effect while `target_power_mode` is set to **Homey control**; switch it back to **Self-consumption (AI)** to hand control back to the battery's own logic.

### Power limits

**Max charge power** and **Max discharge power** (100 to 2400W each, default 800W) are set during pairing and can be changed in device settings afterwards. They are configured per direction because the two directions have different constraints: feed-in rules and house wiring apply to output only.

**These settings limit this app, not the battery.** They are never written to the battery. They bound the `target_power` slider and clamp whatever a flow card asks for, so the app never commands more than you allow. A value beyond the limit is clamped to it, not rejected.

**Two separate caps decide what actually happens.** The setting here bounds what gets _commanded_. The vendor app's "On Grid Output" setting (factory default 800W) caps what the inverter will actually _deliver_, and is not exposed over local TCP at all. Raising the limit here lifts the device's own local cap to match, but it is not enough on its own: to discharge above 800W, "On Grid Output" must also be raised once in the vendor app, per device.

**In Self-consumption (AI) mode neither setting applies.** The app commands nothing in that mode, so the battery follows its own limits and ignores yours. On a test JET with both Homey limits at 800W and the vendor app at 2400W, the battery charged at 2031W and discharged at 1920W under its own logic. That is expected behaviour, not a bug: switch to **Homey control** if you want your limits to bind.

> **Tip for limited circuits:** to charge fast while keeping output safe, set Max charge power to 2400W, Max discharge power to 800W, and leave "On Grid Output" at 800W in the vendor app. This app then never commands more than 800W of output, and the device enforces the same cap itself.

> **Only raise the discharge limit above 800W when the battery is on its own dedicated circuit.** Doing so is at your own risk, see [Disclaimer](#disclaimer).

## Multi-unit / master-slave stacks

A master/slave stack pairs as **one** Homey device, pointed at the master's IP. The master reports whole-stack totals; the slave does not serve the local API while paired, so it cannot be added as a device of its own. Discovery may still list the slave because it is on the network, but it will refuse the connection.

**Manual control reaches the master only.** The AECC local protocol has no per-unit control, and the master does not forward a locally written setpoint to the other units. On a paired stack the secondary keeps executing whatever schedule the vendor app last gave it. This was established on two AEG Solarcube stacks in [aecc-battery-local#16](https://github.com/StekkerDeal/aecc-battery-local/issues/16): every register the integration writes is confirmed applied and matches the state the app leaves behind, yet only the master responds. The app drives the other units through the cloud, which this app deliberately does not use. Totals of the whole stack are unaffected.

**If you need to control both units**, register each battery separately in the vendor app instead of pairing them, so each gets its own IP and answers on port 8080. Pair each as its own Homey device and let your flows send each one its share of the target.

Keep both units in **Homey control** with your flows as the only thing deciding power. Never leave two separately registered units in Self-consumption (AI) on the same meter: each tries to zero the same reading without knowing the other exists, and they end up charging and discharging against each other at full power ([#2](https://github.com/StekkerDeal/aecc-battery-homey/issues/2)).

## Flow cards

This app defines 9 custom flow cards: 3 triggers, 1 condition and 5 actions. They come in addition to what Homey generates automatically from the capabilities table above: the standard capabilities `target_power`, `target_power_mode`, `measure_battery`, `measure_power` and `battery_charging_state` still generate their own flow cards automatically (a trigger for every one of them changing, plus a condition and action pair for the setable ones among them), so you get those for free on top of the 9 listed here. `button.reset_meters` remains a maintenance action rather than a flow card.

### Triggers

| Card                     | ID                        | Tokens                                             | Fires when                                                                                             |
| ------------------------ | ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Control command failed   | `control_write_failed`    | `operation` (text), `attempts` (number)            | All retries are exhausted without an acknowledgement from the battery                                  |
| Setpoint drift corrected | `control_drift_corrected` | `expected` (Expected power), `found` (Found power) | The battery's actual setpoint no longer matches what this app last wrote, and this app has restored it |
| Readings became stale    | `readings_became_stale`   | `seconds` (Seconds since last reading)             | Polling stops producing fresh data. Fires once, not repeatedly while the battery stays unreachable     |

### Conditions

| Card                                                | ID                   | Arguments                          | Checks                                                                                                                              |
| --------------------------------------------------- | -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Data is / is not fresher than `seconds` seconds old | `readings_are_fresh` | `seconds` (number, 5-3600, step 5) | Whether a successful reading arrived within the given number of seconds. Use this to guard other actions from running on stale data |

### Actions

| Card                            | ID                    | Arguments                                              | What it does                                                                                                                                         |
| ------------------------------- | --------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Charge at a set power           | `set_charge_power`    | `power` (0-2400W, step 10)                             | Sets the mode to Homey control and charges at this power. Also callable from HomeyScript                                                             |
| Discharge at a set power        | `set_discharge_power` | `power` (0-2400W, step 10)                             | Sets the mode to Homey control and discharges at this power. Also callable from HomeyScript                                                          |
| Stop                            | `stop_battery`        | none                                                   | Holds an active 0W setpoint with energy management still enabled, unlike switching to self-consumption mode, which hands control back to the battery |
| Set charge and discharge limits | `set_soc_limits`      | `min_soc` (5-50%, step 5), `max_soc` (50-100%, step 5) | Sets the discharge limit to `min_soc` and the charge limit to `max_soc` in a single card                                                             |
| Reapply the setpoint            | `reapply_setpoint`    | none                                                   | Rewrites the current target power to the battery without changing its value. Useful as a recovery step after a failed control command                |

Purpose-built flow cards beyond these may be added in a later version; if you need one that does not exist yet, open an issue describing the automation you are trying to build.

## Troubleshooting

**"Cannot connect" during pairing or afterwards**
This is almost always the single-session limit: something else already holds the battery's one TCP slot. Close the vendor app's local connection and disable the Home Assistant integration (or vice versa) before pairing or troubleshooting this app, then try again.

**Discharge or charge power capped below what I set**
Check the "On Grid Output" setting in the vendor app (Operating Mode Settings). It is a device-level cap on top of this app's own Max charge/discharge power settings, defaults to 800W, and can only be changed in the vendor app; see Control above.

**Multi-unit stack shows only combined totals, and the second unit ignores the setpoint**
Expected, see Multi-unit / master-slave stacks above.

**Energy totals do not match the Home Assistant integration for the same battery**
Expected, see Energy totals above.

**Discovery does not find my battery**
Use **Enter the IP address myself** during pairing instead; this is a normal, fully supported path, not a fallback. Verify the battery answers on TCP port 8080 from a device on the same network first.

### Filing a bug report

Open an issue on [GitHub](https://github.com/StekkerDeal/aecc-battery-homey/issues) with:

- Homey firmware version and this app's version
- The battery's brand and model, as set during pairing
- What you did, what you expected, and what happened instead

If you can reproduce the problem while running a development build (`npm run dev`, see [`docs/development.md`](docs/development.md)), include the relevant lines from the terminal output. Seeing exactly what the app sent and what the battery replied is the fastest way for a maintainer to trace the real cause.

## Credits

The local protocol this app speaks was worked out by the [`aecc-battery-local`](https://github.com/StekkerDeal/aecc-battery-local) Home Assistant integration.

Maintained by [StekkerDeal](https://stekkerdeal.nl/).

## Disclaimer

This app is an independent, community-built project. It is not affiliated with, endorsed by, or supported by AECC or any of the battery brands listed above; those names appear only to describe compatibility.

**Use it at your own risk.** It commands charging and discharging on grid-connected hardware through an undocumented local protocol that was worked out by reverse engineering, and a firmware update can change that protocol without warning. Raising the power limits above the 800W default, either here or in the vendor app, can move more power than your wiring, breaker or socket is rated for. Making sure your installation can carry the power you configure is your responsibility, and if you are not certain, ask a qualified electrician.

Provided as is, without warranty of any kind, as set out in the [LICENSE](LICENSE).

## License

MIT, see [LICENSE](LICENSE)
