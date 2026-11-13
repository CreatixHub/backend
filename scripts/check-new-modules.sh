#!/usr/bin/env bash
# Karkaii backend - end-to-end checks for the 7 modules added in PR #41/#42:
# Staff, Subjects, Classes & Sections, Timetable, Homework, Transport, Assets.
# Same style and helpers as scripts/check-all.sh - read that one first if this looks unfamiliar.
#
#   ./scripts/check-new-modules.sh                  uses http://localhost:5000/api
#   API=http://host:5000/api ./scripts/check-new-modules.sh
#
# Start everything first (from the karkaii folder):  ./demo.sh up
# Creates a fresh owner account + school every run (unique names), so it's safe to repeat; never deletes data.
# Note: sign-up is rate limited (10/minute/address by default) - wait a minute between runs if you hit 429.

API="${API:-http://localhost:5000/api}"
H='content-type: application/json'
RUN=$(date +%s | tail -c 7)
EA="owner-$RUN@example.test"
SA="school-$RUN"
PASS=0; FAIL=0

command -v node >/dev/null && command -v curl >/dev/null || { echo "needs curl and node"; exit 1; }
curl -fsS "$API/health" >/dev/null 2>&1 || { echo "The API is not answering at $API - start it first (./demo.sh up)."; exit 1; }

j()    { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v!==null&&typeof v==="object"?JSON.stringify(v):(v===undefined?"":v))}catch(e){console.log("")}})' "$1"; }
len()  { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.length))'; }
req()  { # method path token body  -> sets CODE and BODY
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

echo "== sign in as an owner (owner role = wildcard permission, so every module below is reachable)"
req POST /auth/signup "" "{\"fullName\":\"Owner\",\"email\":\"$EA\",\"password\":\"Temp-pass-12345\"}"; check "signup" 201 "$CODE"; T0=$(echo "$BODY" | j data.accessToken)
req POST /organizations "$T0" "{\"name\":\"Test School\",\"slug\":\"$SA\"}"; check "create school" 201 "$CODE"
req POST /auth/switch-organization "$T0" "{\"organization\":\"$SA\"}"; check "switch into school" 200 "$CODE"; T=$(echo "$BODY" | j data.accessToken)

echo "== Staff"
req POST /staff "$T" '{"firstName":"Priya","lastName":"Nair","staffType":"teaching","employmentType":"full_time","joinedOn":"2026-06-01"}'
check "create staff" 201 "$CODE"; STAFF1=$(echo "$BODY" | j data.id)
has "employee number auto-generated" '"employeeNo":"EMP-' "$BODY"
has "no sensitive flag set yet" '"hasNationalId":false' "$BODY"
req POST /staff "$T" '{"firstName":"Second","staffType":"non_teaching","employmentType":"part_time","joinedOn":"2026-06-01","nationalId":"A1234567X"}'
check "create staff with national ID" 201 "$CODE"; STAFF2=$(echo "$BODY" | j data.id)
has "national ID flagged present" '"hasNationalId":true' "$BODY"
lacks "raw national ID never returned" "A1234567X" "$BODY"
req GET "/staff" "$T"; check "list staff" 200 "$CODE"
req GET "/staff/$STAFF1" "$T"; check "get one staff" 200 "$CODE"
req PATCH "/staff/$STAFF1" "$T" '{"phone":"9876543210"}'; check "update staff" 200 "$CODE"
req DELETE "/staff/$STAFF2" "$T"; check "retire (soft-delete) staff" 204 "$CODE"
req GET "/staff/$STAFF2" "$T"; check "retired staff disappears from lookup" 404 "$CODE"

echo "== Subjects"
req POST /subjects "$T" '{"code":"MATH10","name":"Mathematics","subjectType":"core"}'
check "create subject" 201 "$CODE"; SUBJECT1=$(echo "$BODY" | j data.id)
req POST /subjects "$T" '{"code":"MATH10","name":"Duplicate","subjectType":"core"}'; check "duplicate code -> 409" 409 "$CODE"
req GET /subjects "$T"; check "list subjects" 200 "$CODE"
req PATCH "/subjects/$SUBJECT1" "$T" '{"name":"Mathematics (Advanced)"}'; check "update subject" 200 "$CODE"

echo "== Classes & Sections"
req POST /classes "$T" '{"gradeLevel":10,"name":"Grade 10","code":"G10"}'
check "create class" 201 "$CODE"; CLASS1=$(echo "$BODY" | j data.id)
req POST /sections "$T" "{\"classId\":\"$CLASS1\",\"name\":\"A\",\"capacity\":40}"
check "create section" 201 "$CODE"; SECTION1=$(echo "$BODY" | j data.id)
req GET "/classes/$CLASS1/subjects" "$T"; check "class subjects (empty at first)" 200 "$CODE"; check "0 subjects yet" 0 "$(echo "$BODY" | len)"
req PUT "/classes/$CLASS1/subjects" "$T" "{\"subjects\":[{\"subjectId\":\"$SUBJECT1\",\"isElective\":false,\"examMarks\":80,\"internalMarks\":20}]}"
check "set class subjects" 200 "$CODE"; check "1 subject now" 1 "$(echo "$BODY" | len)"
req GET /sections "$T"; check "list sections" 200 "$CODE"

echo "== Timetable (time slots, section teachers, entries)"
req POST /time-slots "$T" '{"name":"Period 1","sequence":1,"startsAt":"09:00","endsAt":"09:40"}'
check "create time slot" 201 "$CODE"; SLOT1=$(echo "$BODY" | j data.id)
req POST /time-slots "$T" '{"name":"Bad","sequence":2,"startsAt":"09:40","endsAt":"09:00"}'; check "endsAt before startsAt -> 400" 400 "$CODE"
req POST /section-teachers "$T" "{\"sectionId\":\"$SECTION1\",\"subjectId\":\"$SUBJECT1\",\"academicYearId\":\"1\",\"teacherId\":\"$STAFF1\"}"
check "assign teacher to section+subject" 201 "$CODE"
req POST /timetable "$T" "{\"sectionId\":\"$SECTION1\",\"subjectId\":\"$SUBJECT1\",\"timeSlotId\":\"$SLOT1\",\"dayOfWeek\":1,\"academicYearId\":\"1\",\"effectiveFrom\":\"2026-06-01\"}"
check "create timetable entry" 201 "$CODE"; ENTRY1=$(echo "$BODY" | j data.id)
req POST /timetable "$T" "{\"sectionId\":\"$SECTION1\",\"subjectId\":\"$SUBJECT1\",\"timeSlotId\":\"$SLOT1\",\"dayOfWeek\":1,\"academicYearId\":\"1\",\"effectiveFrom\":\"2026-06-01\"}"
check "clashing entry (same section+slot+day) -> 409" 409 "$CODE"
req GET "/timetable?sectionId=$SECTION1" "$T"; check "list entries for the section" 200 "$CODE"
# classroomId is skipped here - classrooms have no CRUD endpoint of their own yet, so there's no real id to reference.
req PATCH "/timetable/$ENTRY1" "$T" '{"effectiveTo":"2027-03-31"}'; check "update timetable entry" 200 "$CODE"

echo "== Homework (LMS basic)"
req POST /homework "$T" "{\"sectionId\":\"$SECTION1\",\"subjectId\":\"$SUBJECT1\",\"academicYearId\":\"1\",\"teacherId\":\"$STAFF1\",\"title\":\"Chapter 4 exercises\",\"assignedOn\":\"2026-11-20\",\"dueAt\":\"2026-11-27T17:00:00+05:30\"}"
check "create homework" 201 "$CODE"; HW1=$(echo "$BODY" | j data.id)
has "starts as draft" '"status":"draft"' "$BODY"
req POST "/homework/$HW1/publish" "$T"; check "publish homework" 200 "$CODE"; has "now published" '"status":"published"' "$BODY"
req POST "/homework/$HW1/submissions" "$T" '{"enrollmentId":"501","textAnswer":"My answer to the exercises."}'; check "record a submission" 201 "$CODE"; SUB1=$(echo "$BODY" | j data.id)
req GET "/homework/$HW1/submissions" "$T"; check "list submissions" 200 "$CODE"
req PATCH "/homework-submissions/$SUB1/grade" "$T" '{"score":8.5}'; check "grade the submission" 200 "$CODE"; has "now graded" '"status":"graded"' "$BODY"
req POST "/homework/$HW1/close" "$T"; check "close homework" 200 "$CODE"; has "now closed" '"status":"closed"' "$BODY"

echo "== Transport"
req POST /vehicles "$T" '{"registrationNo":"KA01AB1234","vehicleType":"bus","seatingCapacity":40}'
check "create vehicle" 201 "$CODE"; VEHICLE1=$(echo "$BODY" | j data.id)
req POST /drivers "$T" '{"fullName":"Ramesh Kumar","phone":"9876500000","licenseNo":"KA0120230001234","licenseExpiry":"2028-01-01"}'
check "create driver" 201 "$CODE"; DRIVER1=$(echo "$BODY" | j data.id)
req POST /transport-routes "$T" '{"code":"R1","name":"North Loop"}'; check "create route" 201 "$CODE"; ROUTE1=$(echo "$BODY" | j data.id)
req POST /pickup-points "$T" "{\"routeId\":\"$ROUTE1\",\"name\":\"Market Square\",\"sequence\":1,\"monthlyFee\":500}"
check "create pickup point" 201 "$CODE"; POINT1=$(echo "$BODY" | j data.id)
req POST /route-schedules "$T" "{\"routeId\":\"$ROUTE1\",\"vehicleId\":\"$VEHICLE1\",\"driverId\":\"$DRIVER1\",\"shift\":\"morning\",\"operatingDays\":[1,2,3,4,5],\"validFrom\":\"2026-06-01\",\"validTo\":\"2027-03-31\"}"
check "create route schedule" 201 "$CODE"
req POST /transport-assignments "$T" "{\"staffId\":\"$STAFF1\",\"academicYearId\":\"1\",\"routeId\":\"$ROUTE1\",\"pickupPointId\":\"$POINT1\"}"
check "assign staff to the route" 201 "$CODE"; ASSIGN1=$(echo "$BODY" | j data.id)
req POST /transport-assignments "$T" "{\"staffId\":\"$STAFF1\",\"studentId\":\"901\",\"academicYearId\":\"1\",\"routeId\":\"$ROUTE1\",\"pickupPointId\":\"$POINT1\"}"
check "sending BOTH staffId and studentId -> 400" 400 "$CODE"
req DELETE "/transport-assignments/$ASSIGN1" "$T"; check "end the assignment" 204 "$CODE"

echo "== Assets"
req POST /asset-categories "$T" '{"name":"Laptops","depreciationMethod":"straight_line","usefulLifeYears":4}'
check "create asset category" 201 "$CODE"; CAT1=$(echo "$BODY" | j data.id)
req POST /assets "$T" "{\"name\":\"Dell Latitude 5440\",\"categoryId\":\"$CAT1\"}"
check "create asset" 201 "$CODE"; ASSET1=$(echo "$BODY" | j data.id)
has "asset tag auto-generated" '"assetTag":"AST-' "$BODY"
req POST /asset-allocations "$T" "{\"assetId\":\"$ASSET1\",\"staffId\":\"$STAFF1\"}"
check "allocate the asset" 201 "$CODE"; ALLOC1=$(echo "$BODY" | j data.id)
req POST /asset-allocations "$T" "{\"assetId\":\"$ASSET1\",\"staffId\":\"$STAFF1\"}"
check "second open allocation of the same asset -> 409" 409 "$CODE"
req POST "/asset-allocations/$ALLOC1/return" "$T" '{"conditionIn":"good"}'; check "return the allocation" 200 "$CODE"
req POST /asset-allocations "$T" "{\"assetId\":\"$ASSET1\",\"staffId\":\"$STAFF1\"}"
check "re-allocate now that it was returned" 201 "$CODE"; ALLOC2=$(echo "$BODY" | j data.id)
req POST /asset-maintenance "$T" "{\"assetId\":\"$ASSET1\",\"maintenanceType\":\"repair\",\"description\":\"Screen replacement\"}"
check "log a maintenance record" 201 "$CODE"; MAINT1=$(echo "$BODY" | j data.id)
req POST "/asset-allocations/$ALLOC2/return" "$T" '{"conditionIn":"good"}'; check "return it again before disposing" 200 "$CODE"
# disposal is blocked while maintenance is open (reported/in_progress) - close it out first
req PATCH "/asset-maintenance/$MAINT1" "$T" '{"status":"completed"}'; check "complete the maintenance record" 200 "$CODE"
req POST "/assets/$ASSET1/dispose" "$T" '{"disposalValue":50}'; check "dispose the asset" 200 "$CODE"; has "now disposed" '"status":"disposed"' "$BODY"

echo
echo "================================================================================"
printf "Passed: %d   Failed: %d\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
