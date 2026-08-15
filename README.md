# AECC Battery (Homey)

[![Validate](https://github.com/StekkerDeal/aecc-battery-homey/actions/workflows/validate.yml/badge.svg)](https://github.com/StekkerDeal/aecc-battery-homey/actions/workflows/validate.yml)
[![GitHub release](https://img.shields.io/github/release/StekkerDeal/aecc-battery-homey.svg)](https://github.com/StekkerDeal/aecc-battery-homey/releases)
![Maintained](https://img.shields.io/badge/maintained-yes-brightgreen.svg)

A Homey app for **local TCP control** of AECC-platform plug-in home batteries: Sunpura, Lunergy, Voltdeer, AEG Solarcube, AFERIY, AccuMate, JET, Oscal and other batteries built on the same white-labelled platform. It talks directly to the battery over your LAN, no cloud round-trip, and exposes charge state, live power flow, energy totals and full charge/discharge control as Homey capabilities and flow cards.

> **Status:** Early / pre-release. The local protocol itself is proven through the sibling Home Assistant integration, [`aecc-battery-local`](https://github.com/StekkerDeal/aecc-battery-local), which has run against real batteries for months. This Homey app is a fresh implementation of the same protocol and has so far only been exercised against a single device (a JET GreenARK Pro loan unit). Expect rough edges, and please open an issue if your device does not behave as documented.

## Supported devices

Homey-specific testing so far covers only the JET GreenARK Pro, this app's development device. The other rows describe confirmation status on the Home Assistant integration, which speaks the identical protocol; compatibility with this app is expected but not yet independently confirmed on Homey for those. If you try one, please open an issue so this table can be updated.

| Brand    | Model              | Tested on Homey | Notes                                                                                                                                                                                                                             |
| -------- | ------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JET      | GreenARK Pro       | Yes             | Development device for this app                                                                                                                                                                                                   |
| Sunpura  | S2400              | No              | Fully tested on the Home Assistant integration                                                                                                                                                                                    |
| Lunergy  | Hub 2400 AC        | No              | Fully tested on the Home Assistant integration                                                                                                                                                                                    |
| AEG      | Solarcube          | No              | Partial on the Home Assistant integration: monitoring and single-unit control work, multi-unit stacks have an open control limitation, see [`aecc-battery-local#16`](https://github.com/StekkerDeal/aecc-battery-local/issues/16) |
| Voltdeer | SR5000             | No              | Community confirmed on the Home Assistant integration                                                                                                                                                                             |
| AFERIY   | PS240              | No              | Community confirmed on the Home Assistant integration                                                                                                                                                                             |
| AccuMate | Plug-In Battery    | No              | Community confirmed on the Home Assistant integration                                                                                                                                                                             |
| Oscal    | Power Storage 2000 | No              | Community confirmed on the Home Assistant integration                                                                                                                                                                             |

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
4. Homey adds the device. Open its **Settings** to adjust the port (default 8080), the poll interval (default 5 seconds, 2 second floor), and the max charge/discharge power limits (default 800W each, up to the 2400W hardware maximum).

> **Before pairing a second client, read this:** the battery only serves **one TCP connection at a time**. This app, the vendor app's local mode, and the Home Assistant integration all compete for that single slot. Running more than one of them against the same battery at once is the single most common cause of "cannot connect", see Troubleshooting below.

## Capabilities

| Capability                       | Unit | Notes                                                                                                                                      |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `measure_power`                  | W    | Signed: positive = charging, negative = discharging                                                                                        |
| `measure_battery`                | %    | State of charge                                                                                                                            |
| `battery_charging_state`         | -    | Homey's standard charging-state enum (`charging` / `discharging` / `idle`), derived from `measure_power`                                   |
| `meter_power.charged`            | kWh  | Locally integrated charged energy total. See Energy totals below                                                                           |
| `meter_power.discharged`         | kWh  | Locally integrated discharged energy total. See Energy totals below                                                                        |
| `target_power`                   | W    | Signed setpoint, -2400 to 2400: positive = charge, negative = discharge, 0 = idle. Requires Homey firmware 12.13.0 or newer                |
| `target_power_mode`              | -    | `device` (Self-consumption / AI) hands control back to the battery's own logic; `homey` (Homey control) makes `target_power` authoritative |
| `aecc_min_soc` (Discharge limit) | %    | Battery stops discharging at this SOC, 5-50%                                                                                               |
| `aecc_max_soc` (Charge limit)    | %    | Battery stops charging at this SOC, 50-100%                                                                                                |
| `aecc_last_update`               | -    | Timestamp string of the last successful poll                                                                                               |
| `button.reset_meters`            | -    | Maintenance action. Resets both energy meters to zero; breaks this device's Homey Energy history continuity                                |

### Energy totals

`meter_power.charged` and `meter_power.discharged` are integrated locally by this app from the live `measure_power` signal, because the local protocol exposes no cumulative energy counters at all. They will **not** exactly match the equivalent sensors in the Home Assistant integration, which integrates a different pair of signals from the same battery. This is a deliberate choice, not a bug: integrating the one signed power value this app already polls keeps the Homey Energy animation and these two meters internally consistent with each other, at the cost of them drifting slightly from a differently-computed total elsewhere.

## Control

`target_power` is the capability to use for manual control: a single signed number, positive charges, negative discharges, 0 W idles. Setting it to 0 holds an active zero-watt setpoint, which is how you stop the battery, there is no separate "off" state. `target_power` only takes effect while `target_power_mode` is set to **Homey control**; switch it back to **Self-consumption (AI)** to hand control back to the battery's own logic.

Both directions are bounded by the **Max charge power** / **Max discharge power** device settings (default 800W each). A `target_power` value beyond the configured limit is clamped to it, not rejected. Raising either limit above 800W makes the app write register 3039 automatically, lifting the device's own local power cap to match, see [`docs/protocol.md`](docs/protocol.md) for why that register exists.

**The vendor app has a separate cap this app cannot reach.** Its "On Grid Output" setting (factory default 800W) limits what the inverter actually delivers, and is not exposed over local TCP at all. Raising the device settings above 800W in this app is not enough on its own: to discharge above 800W, "On Grid Output" must also be raised once, in the vendor app, per device.

**No multi-unit support in this version.** A real master/slave stack shares a single datalogger and a single IP address, and the slave unit does not serve the local API at all, so it cannot be split into separate Homey devices. Such a stack pairs as **one** Homey device showing whole-stack totals, not one device per physical unit. Two batteries that are _not_ stacked, each registered under its own vendor account, have their own IP addresses and pair as two independent Homey devices normally. See [`aecc-battery-local#16`](https://github.com/StekkerDeal/aecc-battery-local/issues/16) for the open master/slave control limitation on AEG stacks specifically.

## Flow cards

This app does not yet define custom flow cards beyond what Homey generates automatically from the capabilities table above: a trigger for every capability change (including "Battery power changed" and "State of charge changed"), a condition and action pair for every setable capability (`target_power`, `target_power_mode`, `aecc_min_soc`, `aecc_max_soc`), and `button.reset_meters` as a maintenance action rather than a flow card. Purpose-built flow cards may be added in a later version; if you need one that does not exist yet, open an issue describing the automation you are trying to build.

## Troubleshooting

**"Cannot connect" during pairing or afterwards**
This is almost always the single-session limit: something else already holds the battery's one TCP slot. Close the vendor app's local connection and disable the Home Assistant integration (or vice versa) before pairing or troubleshooting this app, then try again.

**Discharge or charge power capped below what I set**
Check the "On Grid Output" setting in the vendor app (Operating Mode Settings). It is a device-level cap on top of this app's own Max charge/discharge power settings, defaults to 800W, and can only be changed in the vendor app; see Control above.

**Multi-unit stack shows only combined totals, not per-battery detail**
Expected in this version, see "No multi-unit support" under Control above.

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

## License

MIT, see [LICENSE](LICENSE)
