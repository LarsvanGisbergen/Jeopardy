# Local Jeopardy Suite

Local Jeopardy game-pack builder and host. Requires Node.js 20 or newer.

## Setup

Install dependencies after cloning the repository:

```powershell
npm install
```

## Run locally in a browser

```powershell
npm start
```

Open [http://localhost:8787/build](http://localhost:8787/build) to manage packs or [http://localhost:8787/play](http://localhost:8787/play) to host a game.

## Run locally as a desktop app

```powershell
npm run electron
```

## Export a Windows executable

Create a single portable `.exe` that can run without installation:

```powershell
npm run package:portable
```

The executable is written to `release\Local Jeopardy Suite <version>.exe`. Copy that file to another Windows computer and launch it directly.

Alternatively, create an unpacked Windows application folder:

```powershell
npm run package:win
```

The unpacked application is written to `release\LocalJeopardySuite-win32-x64\`, with the executable at `release\LocalJeopardySuite-win32-x64\Jeopardy.exe`.

Move or delete older contents from `release\` before packaging if you want it to contain only the newest export.
