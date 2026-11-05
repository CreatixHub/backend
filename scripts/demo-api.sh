#!/usr/bin/env bash
# Karkaii backend - narrated live demo. Calls the REAL running API and explains each step as it goes.
#
#   ./scripts/demo-api.sh            pauses after every step (press Enter) - best for presenting
#   ./scripts/demo-api.sh --fast     no pauses, no waiting - quick check that everything works
#
# Needs the API running (from the karkaii folder:  ./demo.sh up).  API address: $API (default http://localhost:5000/api)
# Uses fresh e-mail addresses and school names every run, so you can repeat it as often as you like.

API="${API:-http://localhost:5000/api}"
FAST=0; [ "${1:-}" = "--fast" ] && FAST=1
H='content-type: application/json'
RUN=$(date +%s | tail -c 6)
EA="principal-$RUN@greenfield.test"; EB="teacher-$RUN@greenfield.test"
SA="greenfield-$RUN"; SB="riverdale-$RUN"
PW='Demo-pass-12345'
JAR=$(mktemp); OLDJAR=$(mktemp)
trap 'rm -f "$JAR" "$OLDJAR"' EXIT

B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
STEP=0; PASS=0; FAIL=0

command -v node >/dev/null && command -v curl >/dev/null || { echo "needs curl and node"; exit 1; }
curl -fsS "$API/health" >/dev/null 2>&1 || { echo "${R}The API is not answering at $API${N}  - start it first:  ./demo.sh up"; exit 1; }

# ---- helpers -------------------------------------------------------------------------------------------------
pause() { [ "$FAST" = 1 ] || { printf "\n${D}   press Enter to continue...${N}"; read -r _; }; }
step()  { STEP=$((STEP+1)); printf "\n${B}${C}[%d] %s${N}\n" "$STEP" "$1"; [ -n "${2:-}" ] && printf "    ${D}%s${N}\n" "$2"; }
say()   { printf "    %s\n" "$1"; }
# pretty-print JSON, hide long tokens, limit the length
pp() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let o=JSON.parse(s);let t=JSON.stringify(o,(k,v)=>typeof v==="string"&&/^eyJ/.test(v)?v.slice(0,14)+"...(token)":v,2).split("\n");const n=+process.argv[1];if(t.length>n){t=t.slice(0,n);t.push("  ...")}console.log(t.map(l=>"      "+l).join("\n"))}catch(e){console.log("      "+s)}})' "${1:-22}"; }
j()  { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v!==null&&typeof v==="object"?JSON.stringify(v):(v===undefined?"":v))}catch(e){console.log("")}})' "$1"; }
# req METHOD PATH TOKEN BODY  -> prints what we send, sets CODE and BODY
req() {
  local m=$1 p=$2 t=${3:-} b=${4:-}
  local args=(-s -X "$m" "$API$p" -H "$H" -b "$JAR" -c "$JAR")
  local shown="curl -X $m $p"
  [ -n "$t" ] && { args+=(-H "Authorization: Bearer $t"); shown+="   (signed in)"; }
  [ -n "$b" ] && { args+=(-d "$b"); shown+="   body: $(printf '%s' "$b" | sed -E 's/"password":"[^"]*"/"password":"********"/')"; }
  printf "    ${Y}> %s${N}\n" "$shown"
  local out; out=$(curl "${args[@]}" -w $'\n%{http_code}')
  CODE=${out##*$'\n'}; BODY=${out%$'\n'*}
}
RATE_HINT=0
expect() { # description expectedCode
  if [ "$CODE" = "429" ] && [ "$RATE_HINT" = 0 ]; then
    RATE_HINT=1
    printf "    ${Y}(!) HTTP 429 = the API's rate limit (100 requests/minute, 10 sign-ins/minute per address) - this is the protection working.${N}\n"
    printf "    ${Y}    You ran a script a moment ago. Wait one minute and start again.${N}\n"
  fi
  if [ "$CODE" = "$2" ]; then PASS=$((PASS+1)); printf "    ${G}<  HTTP %s  OK${N}  - %s\n" "$CODE" "$1"; else FAIL=$((FAIL+1)); printf "    ${R}<  HTTP %s  UNEXPECTED (wanted %s)${N}  - %s\n" "$CODE" "$2" "$1"; fi
}
show() { printf '%s' "$BODY" | pp "${1:-22}"; }

printf "${B}Karkaii backend - live demo${N}   ${D}%s${N}\n" "$API"
printf "${D}A new account, two schools, roles and permissions, isolation and sessions: all against the real API and database.${N}\n"
pause

# ---- 1 -------------------------------------------------------------------------------------------------------
step "The API and its database are up" "GET /api/health runs a real query against PostgreSQL."
req GET /health; expect "healthy" 200; show 6
pause

# ---- 2 -------------------------------------------------------------------------------------------------------
step "Sign up: a principal creates an account" "Passwords are stored only as argon2 hashes. The login session is an httpOnly cookie plus a short-lived token."
req POST /auth/signup "" "{\"fullName\":\"Asha Principal\",\"email\":\"$EA\",\"password\":\"$PW\"}"; expect "account created" 201; show 14
TA0=$(printf '%s' "$BODY" | j data.accessToken)
say "A new person belongs to no school yet: organization is null, no role, no permissions."
pause

step "Security: bad logins all look identical" "An attacker cannot tell which e-mail addresses are registered."
req POST /auth/login "" "{\"email\":\"$EA\",\"password\":\"wrong-password-1\"}"; expect "wrong password" 401; show 4
req POST /auth/login "" "{\"email\":\"nobody-$RUN@example.test\",\"password\":\"wrong-password-1\"}"; expect "unknown e-mail: same answer" 401; show 4
req POST /auth/signup "" "{\"fullName\":\"Asha Again\",\"email\":\"$(echo "$EA" | tr a-z A-Z)\",\"password\":\"$PW\"}"; expect "same e-mail in capitals is refused" 409; show 4
pause

# ---- 3 -------------------------------------------------------------------------------------------------------
step "Create a school (a tenant)" "One database transaction creates the school, its 12 default roles with permissions, and makes the creator its owner."
req POST /organizations "$TA0" "{\"name\":\"Greenfield School\",\"slug\":\"$SA\",\"timezone\":\"Asia/Kolkata\"}"; expect "school created, creator is owner" 201; show 10
req POST /organizations "$TA0" "{\"name\":\"Copy\",\"slug\":\"$SA\"}"; expect "duplicate school name refused" 409; show 4
pause

step "Switch into the school" "The access token now carries the active school. Every request re-checks the membership in the database."
req POST /auth/switch-organization "$TA0" "{\"organization\":\"$SA\"}"; expect "token for Greenfield" 200
TA=$(printf '%s' "$BODY" | j data.accessToken)
say "permissions: $(printf '%s' "$BODY" | j data.user.permissions)   <- the owner can do everything   (the React app is told role '$(printf '%s' "$BODY" | j data.user.role)', its name for a school administrator)"
pause

# ---- 4 -------------------------------------------------------------------------------------------------------
step "Roles and permissions" "110 permissions (11 modules x 10 actions); every school gets its own copy of 12 roles."
req GET /permissions "$TA"; expect "permission catalogue" 200; say "permissions in the catalogue: $(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.length))')"
req GET /roles "$TA"; expect "roles of this school" 200
printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s).data)console.log("      "+r.code.padEnd(18)+(r.code==="owner"?"  all  (wildcard: everything, now and in the future)":String(r.permissions.length).padStart(3)+" permissions"))})'
pause

# ---- 5 -------------------------------------------------------------------------------------------------------
step "The principal adds a teacher" "A new account is created and the person joins the school as 'teacher' in one step."
req POST /members "$TA" "{\"email\":\"$EB\",\"fullName\":\"Ravi Teacher\",\"password\":\"$PW\",\"roles\":[\"teacher\"]}"; expect "teacher added" 201; show 14
MB=$(printf '%s' "$BODY" | j data.id)
req POST /members "$TA" "{\"email\":\"$EB\",\"roles\":[\"teacher\"]}"; expect "adding the same person twice is refused" 409
req GET /members "$TA"; expect "member list (with paging info)" 200; say "members: $(printf '%s' "$BODY" | j meta.total)"
pause

step "The teacher signs in: limited powers" "Permissions come from the role, checked inside the school on every request."
req POST /auth/login "" "{\"email\":\"$EB\",\"password\":\"$PW\"}"; expect "teacher signs in" 200
TB=$(printf '%s' "$BODY" | j data.accessToken)
say "teacher's role: $(printf '%s' "$BODY" | j data.user.role)   (starts in Greenfield, the only school they belong to)"
req PATCH /organizations/current "$TB" '{"name":"Hacked"}'; expect "teacher cannot rename the school" 403; show 4
req GET /members "$TB"; expect "teacher cannot list members" 403; show 4
req GET /organizations/current "$TB"; expect "teacher can see basic school details" 200
pause

# ---- 6 -------------------------------------------------------------------------------------------------------
step "One person, two schools, different roles" "The teacher also creates their own school: one account, a different role in each."
req POST /organizations "$TB" "{\"name\":\"Riverdale School\",\"slug\":\"$SB\"}"; expect "teacher creates Riverdale (becomes its owner)" 201
req POST /auth/switch-organization "$TB" "{\"organization\":\"$SB\"}"; expect "teacher switches into Riverdale" 200
TBB=$(printf '%s' "$BODY" | j data.accessToken)
say "now acting as the OWNER of Riverdale: permissions=$(printf '%s' "$BODY" | j data.user.permissions)   (the same person was only a teacher in Greenfield)"
req GET /organizations "$TBB"; expect "the schools this one person belongs to" 200
printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const o of JSON.parse(s).data)console.log("      "+o.name.padEnd(20)+" role: "+o.roles.join(", "))})'
pause

step "Isolation: one school can never see another" "Riverdale's owner asks for Greenfield's people - and gets nothing of theirs."
req GET /members "$TBB"; expect "Riverdale sees only its own members" 200; say "members visible: $(printf '%s' "$BODY" | j meta.total)  (just the owner)"
req PATCH "/members/$MB" "$TBB" '{"roles":["admin"]}'; expect "cannot edit a Greenfield member from Riverdale" 404; show 4
pause

# ---- 7 -------------------------------------------------------------------------------------------------------
step "Changes take effect immediately" "The principal changes the teacher's role, then suspends them: their existing token stops working at once."
req PATCH "/members/$MB" "$TA" '{"roles":["receptionist"]}'; expect "teacher becomes receptionist" 200
req GET /organizations/current "$TB"; expect "same old token, new powers" 200; say "now: $(printf '%s' "$BODY" | j data.myRoles)"
req PATCH "/members/$MB" "$TA" '{"status":"suspended"}'; expect "membership suspended" 200
req GET /auth/me "$TB"; expect "the old token is dead immediately" 401
req PATCH "/members/$MB" "$TA" '{"status":"active"}'; expect "reactivated" 200
pause

step "Protection against mistakes and abuse" "A school always keeps an owner; nobody edits their own access; only owners can create owners."
OWNERMEM=$(curl -s "$API/members?limit=50" -H "Authorization: Bearer $TA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(m=>m.email===process.argv[1]).id))' "$EA")
req PATCH "/members/$OWNERMEM" "$TA" '{"status":"suspended"}'; expect "the owner cannot suspend themselves" 400; show 4
req POST /roles "$TA" '{"code":"hod","name":"Head of Department","permissions":["dashboard.view","students.view","attendance.view"]}'; expect "a school can create its own role" 201
req GET /organizations/current ""; expect "no token at all: refused" 401
pause

# ---- 8 -------------------------------------------------------------------------------------------------------
step "Sessions: rotating refresh tokens with theft detection" "Each refresh cookie works once. Replaying an old one is treated as theft."
: > "$JAR"
req POST /auth/login "" "{\"email\":\"$EA\",\"password\":\"$PW\"}"; expect "sign in (sets the httpOnly cookie)" 200
cp "$JAR" "$OLDJAR"
req POST /auth/refresh; expect "refresh: new token and a new cookie" 200
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/refresh" -b "$OLDJAR"); printf "    ${Y}> replay the OLD cookie immediately${N}\n"; expect "409: a harmless race (two browser tabs), nothing revoked" 409
if [ "$FAST" = 1 ]; then say "(skipping the 12-second wait in --fast mode)"; else
  say "waiting 12 seconds, then replaying the old cookie again..."; sleep 12
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/refresh" -b "$OLDJAR"); expect "old cookie replayed later = theft: refused" 401
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/refresh" -b "$JAR"); expect "...and the whole login is revoked, even the new cookie" 401
fi
pause

# ---- summary -------------------------------------------------------------------------------------------------
printf "\n${B}Summary${N}\n"
printf "  checks shown: %d   ${G}as expected: %d${N}   ${R}unexpected: %d${N}\n" "$((PASS+FAIL))" "$PASS" "$FAIL"
printf "  ${D}Created for this run: accounts %s and %s, schools %s and %s (visible in Prisma Studio).${N}\n" "$EA" "$EB" "$SA" "$SB"
[ "$FAIL" = 0 ]
