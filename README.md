# My Pi setup

Extensions and skills I use in [Pi](https://pi.dev/).

If you want to install these yourself you can clone the repo and run:

```sh
pi install /path/to/repo
```

## Extensions

Custom written extensions that I've found useful, some used more than others.

### Custom status bar

Custom status bar overriding the one provided by Pi itself. Shows some useful information like
the model in use, effort level, in/out tokens, session usage etc.

[Source](extensions/custom-status-bar.ts)

### Model effort command

Custom `/effort` command that allows me to switch the effort/thinking level of the model without
having to go thorugh the `/settings` menu.

[Source](extensions/effort.ts)
