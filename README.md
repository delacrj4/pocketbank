# PocketBank

A local banking demo built with Angular, Express, TypeScript, and SQLite. Create an account, open savings, transfer pretend money, and view transaction history. Your accounts and balances persist between restarts.

This is a learning project using fake money, intended to run on your own computer.

## Install and run

### 1. Install the prerequisites

- Install **Node.js 24.15 or newer within version 24** from [nodejs.org](https://nodejs.org/en/download). npm is included. Other major versions are not supported by this project.
- Install [Git](https://git-scm.com/downloads) if you want to use the clone command below.
- After installing, close and reopen your terminal (PowerShell on Windows, Terminal on macOS/Linux).

Check that Node and npm work:

```sh
node --version
npm --version
```

The first command should print `v24.x.x` (at least `v24.15.0`). If either command is not found, reinstall Node and reopen your terminal. If PowerShell says scripts are disabled for npm, use `npm.cmd` instead of `npm` in the commands below.

### 2. Download the project

In your terminal, go to the folder where you want to keep the project, then run these commands one at a time:

```sh
git clone https://github.com/delacrj4/pocketbank.git
cd pocketbank
```

Alternatively, on GitHub choose **Code > Download ZIP**, extract the ZIP, and open a terminal inside the extracted project folder.

**You are in the right folder when you can see `package.json`, `client`, and `server`.** Run all remaining commands from this folder.

### 3. Install dependencies

```sh
npm ci
```

Wait for this command to finish. You only need to do this on the first setup, or after downloading changes to the dependencies.

### 4. Start the app

```sh
npm start
```

Leave this terminal open. This command starts both the website and its API. Wait for Angular to finish compiling, then open this exact address in your browser:

**http://127.0.0.1:4200**

There is no separate database installation, configuration file, or API key to set up. The local SQLite database is created automatically on the first run.

### 5. Create your first account

Click **Create an account**, enter a display name and an email address, and choose a password of 6–128 characters. Enter the same password in the confirmation field. Email verification is not required; use a made-up address such as `alice@example.com` and a password just for this demo.

Every new account starts with **$1,000 in pretend money** in checking. You can open one savings account, starting at $0, and transfer money between your accounts.

To test payments to another user, create a second account in a private window or separate browser profile. Copy that user's checking account number and use it as the recipient. Click **Refresh balances** on the recipient's dashboard to see incoming payments.

### Stop and start again

To stop: return to the terminal running the app and press **Ctrl+C**. If Windows asks whether to terminate the batch job, enter **Y**.

To start again: open a terminal in the project folder and run `npm start`. Your existing accounts and transaction history will still be there. If you restart after updating the code, stop the previous servers first.

## Troubleshooting

- **The page will not load:** keep `npm start` running and wait for compilation to finish. Use `http://127.0.0.1:4200`, not HTTPS.
- **A port is already in use:** stop any previous copy of PocketBank. The website needs port 4200 and the API needs port 3000.
- **The API is unavailable:** start with `npm start` from the project root so both servers run together. Check the terminal for errors.
- **Two tabs show the same account:** normal tabs share a sign-in cookie. Use a private window or a different browser profile for a second user. Keep using `127.0.0.1` in both windows.
- **Node prints an experimental SQLite warning:** this can occur with Node 24; the project uses its built-in SQLite module.

## Development checks

Run these from the project root:

```sh
npm run check
npm test
npm run build
```

These check the backend types, run HTTP integration tests against a temporary database, and compile the backend and frontend. Tests do not use your local app data. The build command compiles the project; use `npm start` to run it locally.

## Local data and project layout

- `client/src/app/`: Angular forms, dashboard, and styles.
- `server/src/`: API, authentication, account rules, and SQLite storage.
- `server/banking.test.ts`: integration tests.
- `server/data/`: local database, excluded from Git.

Passwords are stored as salted hashes. Transfers validate ownership and balances, and update balances and history in a single database transaction. Transfers use USD, have no fees, and do not allow overdrafts. Live incoming notifications, password recovery, and email verification are not implemented.
