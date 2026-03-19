# Testing a Local Build Globally

## Set up (use local build)

```bash
bun run build
rm -f /opt/homebrew/bin/backlog
ln -s /Users/tim/git/timgranlundmarsden.github.com/Backlog.md/dist/backlog /opt/homebrew/bin/backlog
```

> Note: `npm link` does NOT work here because `package.json`'s `bin` points to
> `scripts/cli.cjs` (the published wrapper), not the compiled `dist/backlog` binary.

## Rebuild (after making changes)

```bash
bun run build
# symlink already in place — no further steps needed
```

## Unset (restore published version)

```bash
rm /opt/homebrew/bin/backlog
npm install -g backlog.md
```
