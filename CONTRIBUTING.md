# Contributing

Thanks for wanting to help. Reports from batteries we have not tested are the
most valuable contribution there is, so please do share them.

## Open an issue first

For a new feature or a change in behaviour, open an issue before writing code,
so we can agree on the design before you put work into it. A pull request for a
change that was not discussed first will usually be closed.

Typo and documentation fixes can go straight to a pull request.

## What decides whether a change fits

- **Homey or the vendor app, never both.** The app either controls the battery
  (Homey control) or hands it back to the device's own logic
  (Self-consumption / AI). Features that mirror or change the vendor app's
  settings from Homey do not fit.
- **No EMS on/off switch.** Writing EMS off locally does not stick, the
  firmware turns it back on within a poll. Stop the battery with the Stop
  action or a 0 W target.
- **One app for every AECC brand.** Brand-specific extensions belong in their
  own project.
- **Proven on a real battery.** A change to control or telemetry is tested on
  hardware, not only in the test suite. Say which battery and firmware you
  tested on.

## Before you open a pull request

- Run `.\scripts\check.ps1`, the same checks as CI.
- Regenerate and commit `app.json` if `.homeycompose` changed.
- Update the README when capabilities, flow cards or behaviour change, and the
  `en` and `nl` translations when user-visible strings change.
- Leave version numbers and releases to us: do not bump the version in
  `app.json` or `package.json`, tag, or write release notes.
- No secrets, real device serial numbers or WiFi credentials in code or logs.
