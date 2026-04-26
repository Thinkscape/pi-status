# pi-status

A small [pi](https://github.com/badlogic/pi-mono) extension that shows a spinner in the terminal tab title while pi is working, then restores the title when the turn finishes.

The title format is:

```text
⠋ π - <session name> - <cwd>
```

If the session has no name, it uses:

```text
⠋ π - <cwd>
```

## Install

From this checkout:

```bash
pi install /absolute/path/to/pi-status
```

Or test it for one run:

```bash
pi -e /absolute/path/to/pi-status
```

## Commands

```text
/pi-status          show current status
/pi-status status   show current status
/pi-status on       enable the spinner for this session
/pi-status off      disable the spinner for this session
```

## Environment

Disable the extension by default:

```bash
PI_STATUS_DISABLED=1 pi
```

Accepted truthy values are `1`, `true`, `yes`, and `on`.

## Development

```bash
pnpm install
pnpm run check
```
