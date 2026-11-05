# Karkaii API: HTTPie command list

Copy-paste commands to create users, start sessions and try the API from a terminal. No frontend needed.
The explanations and sample output are in `HTTPIE-SESSIONS-GUIDE.pdf` (same folder).

The same endpoints are also documented interactively at **http://localhost:5000/api/docs** (Swagger UI, with a
"Try it out" button), and the raw OpenAPI file is at `http://localhost:5000/api/openapi.json`.

How it works in one line: `--session=NAME` makes HTTPie act like one browser. It saves the refresh cookie and the
access token in a file called NAME and sends them again on the next command. **To act as a different person, change `NAME`.**

The commands contain no `#` comments, so they paste into bash and zsh.

---

## 0. Setup (once per terminal window)

Install the tools and start the backend:

```
sudo pacman -S --needed httpie jq
cd ~/karkaii
./demo.sh up
```

Check that both tools are installed (each line must print a path; if one prints nothing, install it with the `pacman`
line above, which asks for your sudo password):

```
command -v http jq
```

Set the helpers. Paste them **one block at a time** and check afterwards with `echo $API $PW`:

```
export API=localhost:5000/api
export PW='Temp-pass-12345'
tok() { jq -r .data.accessToken; }
```

If `jq` is not installed and you cannot use sudo, replace the `tok` helper with this version, which uses Node instead
(Node is already installed for the backend):

```
tok() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.accessToken))'; }
```

Check the API answers:

```
http GET $API/health
```

---

## 1. Create a new user and make it your current session

Pick a name for the session and an email for the user, then sign up. The reply holds the access token, and `--session`
saves the refresh cookie.

```
export NAME=carol
export EMAIL=carol@example.test
```

```
TOKEN=$(http --session=$NAME --print=b POST $API/auth/signup fullName="Carol Principal" email=$EMAIL password=$PW | tok)
```

Store the token in the session and check who you are:

```
http --session=$NAME -A bearer -a "$TOKEN" GET $API/auth/me
```

To see the full sign-up reply (headers, cookie, body), run it without `--print=b` and without `| tok`:

```
http --session=$NAME POST $API/auth/signup fullName="Carol Principal" email=$EMAIL password=$PW
```

Rules: the password needs at least 10 characters, the email must be new (otherwise 409).

If the sign-up command fails half-way (for example `tok: command not found: jq`), the account may **already exist**
even though no session was saved. Do not sign up again (that gives 409). Sign in instead (section 4). Check first that
`echo $NAME $EMAIL` prints both values.

A new account has **no school yet**: `role` is `null` and `organizations` is empty.

---

## 2. Create a school and switch into it

```
export SLUG=carol-school
```

```
http --session=$NAME POST $API/organizations name="Carol School" slug=$SLUG
```

Creating the school makes you its owner, but your current token still has no school. Ask for a token that has one:

```
TOKEN=$(http --session=$NAME --print=b POST $API/auth/switch-organization organization=$SLUG | tok)
http --session=$NAME -A bearer -a "$TOKEN" GET $API/auth/me
```

You should now see `"role": "admin"` and `"permissions": ["*"]`.

The slug is 3 to 41 characters: lowercase letters, digits and hyphens.

---

## 3. Switch to another user (another session)

Change `NAME` and `EMAIL`. Everything after that runs as that person.

```
export NAME=dave
export EMAIL=dave@example.test
```

Each name has its own file. List them, look inside one, or delete one:

```
ls ~/.config/httpie/sessions/localhost_5000/
cat ~/.config/httpie/sessions/localhost_5000/$NAME.json
rm ~/.config/httpie/sessions/localhost_5000/$NAME.json
```

The files hold live logins. Do not paste them into chats or tickets.

---

## 4. Sign in (an existing user)

```
TOKEN=$(http --session=$NAME --print=b POST $API/auth/login email=$EMAIL password=$PW | tok)
http --session=$NAME -A bearer -a "$TOKEN" GET $API/auth/me
```

To start in a specific school (when the person belongs to several):

```
TOKEN=$(http --session=$NAME --print=b POST $API/auth/login email=$EMAIL password=$PW organization=$SLUG | tok)
```

Once the token is saved in the session (the `-A bearer -a` step), later commands do not repeat it:

```
http --session=$NAME GET $API/auth/me
```

---

## 5. Add a person to the school (the owner does this)

Sign in as the owner first (section 4, with `NAME=carol`). Then add a **new** person with a role:

```
http --session=$NAME POST $API/members email=dave@example.test fullName="Dave Teacher" password=$PW roles:='["teacher"]'
```

This creates the account and the membership in one call. To add someone who **already has an account**, leave out the name
and password:

```
http --session=$NAME POST $API/members email=dave@example.test roles:='["accountant"]'
```

Roles you can use: `owner`, `admin`, `teacher`, `accountant`, `receptionist`, `student`, `parent`, `librarian`, `warden`,
`transport_manager`, `nurse`, `security`. See them all:

```
http --session=$NAME GET $API/roles
```

List, search, change and remove members. `ID` is the member `id` from the list, not the `userId`:

```
http --session=$NAME GET $API/members
http --session=$NAME GET $API/members q==dave
http --session=$NAME PATCH $API/members/ID roles:='["accountant"]'
http --session=$NAME PATCH $API/members/ID status=suspended
http --session=$NAME DELETE $API/members/ID
```

`roles:=[...]` uses `:=` because the value is a JSON array, not a string.

---

## 6. Act as the new person

Open the new person's own session and compare what they may do:

```
export NAME=dave
export EMAIL=dave@example.test
TOKEN=$(http --session=$NAME --print=b POST $API/auth/login email=$EMAIL password=$PW | tok)
http --session=$NAME -A bearer -a "$TOKEN" GET $API/members
http --session=$NAME GET $API/organizations/current
```

A teacher gets **403** on the member list and **200** on the school. That is permissions at work.

---

## 7. Refresh (when the access token has expired, after 15 minutes)

A `401 Unauthorized` on a normal call usually means the access token expired. Swap the cookie for a new token:

```
TOKEN=$(http --session=$NAME --print=b POST $API/auth/refresh | tok)
http --session=$NAME -A bearer -a "$TOKEN" GET $API/auth/me
```

The cookie in the session file changes at every refresh. Each refresh cookie works **once**.

---

## 8. A second device for the same person

Same user, but a separate login with its own cookie:

```
export NAME=carol
export EMAIL=carol@example.test
TOKEN=$(http --session=$NAME-phone --print=b POST $API/auth/login email=$EMAIL password=$PW organization=$SLUG | tok)
http --session=$NAME-phone -A bearer -a "$TOKEN" GET $API/auth/me
```

---

## 9. Log out

```
http --session=$NAME-phone POST $API/auth/logout
http --session=$NAME-phone POST $API/auth/refresh
```

The first gives `204`. The second gives `401`, because the session is revoked. The other sessions of the same person keep
working.

---

## 10. Stolen-cookie test

Copy a session file (the "attacker"), refresh as the real user, then replay the old cookie:

```
SD=~/.config/httpie/sessions/localhost_5000
cp $SD/$NAME.json $SD/$NAME-stolen.json
http --session=$NAME POST $API/auth/refresh
http --session=$NAME-stolen POST $API/auth/refresh
```

Expected: `200`, then `409` (an old cookie used within 10 seconds looks like a harmless race, nothing is revoked).

Wait, then replay again:

```
sleep 12
http --session=$NAME-stolen POST $API/auth/refresh
http --session=$NAME POST $API/auth/refresh
```

Expected: `401` and `401`. The server revokes the whole login chain, so the real user must sign in again (section 4).

---

## 11. Errors worth showing

These use no `--session`, so they do not touch your saved logins.

```
http POST $API/auth/signup fullName="Carol Principal" email=carol@example.test password=$PW
http POST $API/auth/signup fullName="Zed Zed" email=zed@example.test password=short
http POST $API/auth/login email=carol@example.test password=wrong-password
http POST $API/auth/login email=nobody@example.test password=wrong-password
http GET $API/auth/me
```

| Request | Answer | Message |
|---|---|---|
| sign up with an existing email | 409 | An account with this email already exists |
| password shorter than 10 | 400 | Validation failed, with `errors: [{ field, message }]` |
| wrong password, and unknown email | 401 | the same: Invalid email or password |
| no token | 401 | Unauthorized |
| too many sign-ins (more than 10 a minute) | 429 | wait a minute |

---

## 12. Reset

Forget all saved logins, and optionally empty the local database:

```
rm -f ~/.config/httpie/sessions/localhost_5000/*.json
cd ~/karkaii && ./demo.sh reset-db
```

---

## Quick reference

| Endpoint | What it does | Needs |
|---|---|---|
| `POST /auth/signup` | create a user and start a session | nothing |
| `POST /auth/login` | sign in (optional `organization=slug`) | nothing |
| `POST /auth/refresh` | new access token from the cookie | the `rt` cookie |
| `POST /auth/logout` | revoke the session | the `rt` cookie |
| `GET /auth/me` | who am I, which school, which permissions | access token |
| `POST /auth/switch-organization` | change the active school | access token |
| `POST /organizations`, `GET /organizations` | create a school, list mine | access token |
| `GET/PATCH /organizations/current` | read or rename the active school | permission |
| `GET/POST /members`, `PATCH/DELETE /members/ID` | manage people in the school | permission |
| `GET /roles`, `GET /permissions` | roles and the permission catalogue | permission |

| HTTPie | Meaning |
|---|---|
| `key=value` | JSON string field |
| `key:=value` | raw JSON (number, array, true, null) |
| `key==value` | query string (`?key=value`) |
| `--session=NAME` | remember cookies and token in the file NAME |
| `-A bearer -a "$TOKEN"` | send `Authorization: Bearer ...` |
| `--print=b` / `hb` / `H` | print body / headers and body / request headers |
| `-v` | print the full request and response |
| `--ignore-stdin` | add this in scripts (see below) |

## Troubleshooting

- **401 on a normal call:** the token is older than 15 minutes (section 7), you never passed `-A bearer -a "$TOKEN"` in that
  session, or the session was revoked (sign in again).
- **409 on sign-up:** that email already exists. Use another one, or run `./demo.sh reset-db`.
- **429:** rate limit of 10 sign-ups or sign-ins a minute. Wait one minute.
- **Connection refused / 500:** the backend or database is not running. Run `./demo.sh status`, then `./demo.sh up`.
- **A command works by hand but a script gets 401:** when input is not a terminal, HTTPie turns a `GET` into a `POST`.
  In scripts, write the method (`http GET ...`) and add `--ignore-stdin`.
