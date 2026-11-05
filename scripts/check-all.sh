#!/usr/bin/env bash
# Karkaii backend - 60 automated end-to-end checks against a RUNNING API and its database.
#
#   ./scripts/check-all.sh                       uses http://localhost:5000/api
#   API=http://host:5000/api ./scripts/check-all.sh
#
# Start everything first (from the karkaii folder):  ./demo.sh up
# It creates fresh accounts and schools every run (unique names), so it can be repeated; it never deletes data.
# Note: sign-up/sign-in are rate limited (10 per minute per address by default); wait a minute between runs.

API="${API:-http://localhost:5000/api}"
H='content-type: application/json'
RUN=$(date +%s | tail -c 7)
EA="alice-$RUN@example.test"; EB="bob-$RUN@example.test"; EC="carol-$RUN@example.test"
SA="school-a-$RUN"; SB="school-b-$RUN"
PASS=0; FAIL=0

command -v node >/dev/null && command -v curl >/dev/null || { echo "needs curl and node"; exit 1; }
curl -fsS "$API/health" >/dev/null 2>&1 || { echo "The API is not answering at $API - start it first (./demo.sh up)."; exit 1; }

j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v!==null&&typeof v==="object"?JSON.stringify(v):(v===undefined?"":v))}catch(e){console.log("")}})' "$1"; }
idof() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const m=o.data.find(x=>x.email===process.argv[1]);console.log(m?m.id:"")})' "$1"; }
len() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.length))'; }
req() { # method path token body  -> sets CODE and BODY
  local args=(-s -X "$1" "$API$2" -H "$H")
  [ -n "${3:-}" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "${4:-}" ] && args+=(-d "$4")
  local out; out=$(curl "${args[@]}" -w $'\n%{http_code}')
  CODE=${out##*$'\n'}; BODY=${out%$'\n'*}
}
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf "  ok    %s\n" "$1"; else FAIL=$((FAIL+1)); printf "  FAIL  %s   (expected %s, got %s)\n" "$1" "$2" "$3"; fi; }
has()   { case "$3" in *"$2"*) PASS=$((PASS+1)); printf "  ok    %s\n" "$1";; *) FAIL=$((FAIL+1)); printf "  FAIL  %s   (missing %s in %s)\n" "$1" "$2" "$(echo "$3" | cut -c1-150)";; esac; }
lacks() { case "$3" in *"$2"*) FAIL=$((FAIL+1)); printf "  FAIL  %s   (should NOT contain %s)\n" "$1" "$2";; *) PASS=$((PASS+1)); printf "  ok    %s\n" "$1";; esac; }

req GET /health; check "health" 200 "$CODE"

echo "== accounts and schools"
req POST /auth/signup "" "{\"fullName\":\"Alice Owner\",\"email\":\"$EA\",\"password\":\"Temp-pass-12345\"}"; check "signup alice" 201 "$CODE"; TA0=$(echo "$BODY" | j data.accessToken)
req POST /auth/signup "" "{\"fullName\":\"Bob Teacher\",\"email\":\"$EB\",\"password\":\"Temp-pass-12345\"}"; check "signup bob" 201 "$CODE"
req GET /organizations/current "$TA0"; check "no school yet -> 403" 403 "$CODE"
req POST /organizations "$TA0" "{\"name\":\"School A\",\"slug\":\"$SA\"}"; check "alice creates school A" 201 "$CODE"
req POST /organizations "$TA0" "{\"name\":\"Dup\",\"slug\":\"$SA\"}"; check "duplicate slug" 409 "$CODE"
req POST /organizations "$TA0" "{\"name\":\"Adm\",\"slug\":\"admin\"}"; check "reserved slug" 400 "$CODE"
req POST /auth/switch-organization "$TA0" "{\"organization\":\"$SA\"}"; check "alice switches into A" 200 "$CODE"; TA=$(echo "$BODY" | j data.accessToken)
has "alice role is admin (owner->admin)" '"role":"admin"' "$BODY"
has "alice has wildcard" '"permissions":["*"]' "$BODY"
req GET /organizations/current "$TA"; check "alice current" 200 "$CODE"
req PATCH /organizations/current "$TA" '{"name":"School A Renamed"}'; check "owner can rename" 200 "$CODE"
req POST /auth/switch-organization "$TA" '{"organization":"nowhere-at-all"}'; check "switch to unknown school" 403 "$CODE"

echo "== catalogue and roles"
req GET /permissions "$TA"; check "permissions" 200 "$CODE"; check "110 permissions" 110 "$(echo "$BODY" | len)"
req GET /roles "$TA"; check "roles" 200 "$CODE"; check "12 default roles" 12 "$(echo "$BODY" | len)"

echo "== members"
req POST /members "$TA" "{\"email\":\"$EB\",\"roles\":[\"teacher\"]}"; check "add existing account bob as teacher" 201 "$CODE"; MB=$(echo "$BODY" | j data.id)
req POST /members "$TA" "{\"email\":\"$EC\",\"fullName\":\"Carol Accountant\",\"password\":\"Temp-pass-12345\",\"roles\":[\"accountant\"]}"; check "add new account carol" 201 "$CODE"; MC=$(echo "$BODY" | j data.id)
req POST /members "$TA" "{\"email\":\"$EB\",\"roles\":[\"teacher\"]}"; check "already a member" 409 "$CODE"
req POST /members "$TA" "{\"email\":\"x-$RUN@example.test\",\"roles\":[\"teacher\"]}"; check "new account needs name+password" 400 "$CODE"; has "400 lists field errors" '"field":"password"' "$BODY"
req POST /members "$TA" "{\"email\":\"y-$RUN@example.test\",\"fullName\":\"Y Y\",\"password\":\"Temp-pass-12345\",\"roles\":[\"wizard\"]}"; check "unknown role" 400 "$CODE"
req GET "/members?limit=10" "$TA"; check "list members" 200 "$CODE"; has "meta.total is 3" '"total":3' "$BODY"
req GET "/members?q=carol" "$TA"; has "search finds carol" 'Carol Accountant' "$BODY"; lacks "search hides bob" 'Bob Teacher' "$BODY"
req GET "/members?limit=10" "$TA"; MA=$(echo "$BODY" | idof "$EA")
req PATCH "/members/$MA" "$TA" '{"status":"suspended"}'; check "cannot suspend yourself" 400 "$CODE"

echo "== one person, two schools, different roles"
req POST /auth/login "" "{\"email\":\"$EB\",\"password\":\"Temp-pass-12345\"}"; check "bob logs in" 200 "$CODE"; TB=$(echo "$BODY" | j data.accessToken)
has "bob starts in school A as teacher" '"role":"teacher"' "$BODY"
req GET /organizations/current "$TB"; check "bob reads school A" 200 "$CODE"; has "bob lacks organization.edit" '"myRoles":["teacher"]' "$BODY"; lacks "bob not owner perms" '"organization.edit"' "$BODY"
req PATCH /organizations/current "$TB" '{"name":"Hacked"}'; check "teacher cannot rename school" 403 "$CODE"
req GET /members "$TB"; check "teacher cannot list members" 403 "$CODE"
req POST /organizations "$TB" "{\"name\":\"School B\",\"slug\":\"$SB\"}"; check "bob creates his own school B" 201 "$CODE"
req POST /auth/switch-organization "$TB" "{\"organization\":\"$SB\"}"; check "bob switches into B" 200 "$CODE"; TBB=$(echo "$BODY" | j data.accessToken)
has "bob is admin (owner) in B" '"permissions":["*"]' "$BODY"
req GET /organizations "$TBB"; has "bob sees both schools" "$SA" "$BODY"; has "bob sees school B too" "$SB" "$BODY"
req PATCH /organizations/current "$TBB" '{"name":"School B Renamed"}'; check "bob can rename B" 200 "$CODE"

echo "== isolation"
req GET /members "$TBB"; check "B lists its own members" 200 "$CODE"; has "B sees only itself" '"total":1' "$BODY"
req PATCH "/members/$MC" "$TBB" '{"roles":["admin"]}'; check "B cannot edit A's member" 404 "$CODE"
req DELETE "/members/$MC" "$TBB"; check "B cannot delete A's member" 404 "$CODE"

echo "== changing roles and access takes effect immediately"
req PATCH "/members/$MB" "$TA" '{"roles":["receptionist"]}'; check "alice changes bob to receptionist" 200 "$CODE"
req GET /organizations/current "$TB"; has "bob's old token now has receptionist perms" 'admissions.view' "$BODY"
req PATCH "/members/$MB" "$TA" '{"roles":["owner"]}'; check "owner may grant owner" 200 "$CODE"
req PATCH "/members/$MB" "$TA" '{"roles":["teacher"]}'; check "demote bob back" 200 "$CODE"
req PATCH "/members/$MB" "$TB" '{"roles":["owner"]}'; check "bob (teacher) cannot edit members" 403 "$CODE"
req PATCH "/members/$MB" "$TA" '{"status":"suspended"}'; check "suspend bob in A" 200 "$CODE"
req GET /auth/me "$TB"; check "bob's school-A token is dead at once" 401 "$CODE"

echo "== role management"
req POST /roles "$TA" '{"code":"librarian_plus","name":"Librarian Plus","permissions":["dashboard.view","students.view"]}'; check "create custom role" 201 "$CODE"; RID=$(echo "$BODY" | j data.id)
req POST /roles "$TA" '{"code":"bad_one","name":"Bad","permissions":["nope.nope"]}'; check "unknown permission" 400 "$CODE"
req PATCH "/roles/$RID" "$TA" '{"name":"Librarian Plus+","permissions":["dashboard.view"]}'; check "edit custom role" 200 "$CODE"
req GET /roles "$TA"; TID=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(r=>r.code==="teacher").id))')
req PATCH "/roles/$TID" "$TA" '{"name":"Xy"}'; check "system role cannot be edited" 403 "$CODE"
req DELETE "/roles/$TID" "$TA"; check "system role cannot be deleted" 403 "$CODE"
req DELETE "/roles/$RID" "$TA"; check "delete unused custom role" 204 "$CODE"
req DELETE "/members/$MC" "$TA"; check "remove carol" 204 "$CODE"
req GET /members "$TA"; has "carol is gone (total 2)" '"total":2' "$BODY"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
