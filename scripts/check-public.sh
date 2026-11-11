#!/usr/bin/env bash
# Runs the terminal checks of docs/try-it.md, steps a1 to a11, against the
# live deployment: house.atnx.testnet on NEAR testnet and the hosted demo.
# Read-only: view calls, transaction reads and GET/POST requests that change
# nothing (a10 asks for a dry quote). Needs bash, curl and jq; a9 hashes
# with sha256sum, or shasum on macOS.
#
#   bash scripts/check-public.sh
#
# Prints one line per step, "ok aN <what it checked>" or "FAIL aN <what it
# got>", and exits non-zero when any step fails. RPC, ARCHIVAL and SITE can
# be overridden from the environment.
#
# The expected values below are the ones the README and docs/try-it.md
# state; change them together.
set -u

RPC=${RPC:-https://test.rpc.fastnear.com}
ARCHIVAL=${ARCHIVAL:-https://archival-rpc.testnet.fastnear.com}
SITE=${SITE:-https://atnx-near.vercel.app}
HOUSE=house.atnx.testnet
CODE_HASH=EN6eaeUyNxp1VUJ5nWDtv3wTNmHrx53u7eNPwTScEnb3
SOURCE_COMMIT=5c019b5a2d8466ccdaebcf8b1a943ed082863f0e
MARKET=36
GUEST=guest-6hy3hp2e-h.atnx.testnet
RELAYED_TX=CdUcNMujXLZoampMXFp7k72scgVs8dAoEYHzodafkVJD

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "FAIL setup: $tool is not installed"; exit 2; }
done
if command -v sha256sum >/dev/null; then sha256() { sha256sum | cut -d' ' -f1; }
elif command -v shasum >/dev/null; then sha256() { shasum -a 256 | cut -d' ' -f1; }
else echo "FAIL setup: neither sha256sum nor shasum is installed"; exit 2
fi

failures=0

get() { curl -s -m 30 --retry 2 "$@"; }

rpc() {  # rpc <url> <json body>
  get "$1" -H 'content-type: application/json' -d "$2"
}

house_view() {  # house_view <method> '<arguments as JSON>'
  rpc "$RPC" "$(jq -nc --arg c "$HOUSE" --arg m "$1" --arg a "$(printf '%s' "$2" | base64 | tr -d '\n')" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:$c,method_name:$m,args_base64:$a}}')" \
    | jq -c '.result.result | implode | fromjson'
}

query() {  # query <request_type> <account>
  rpc "$RPC" "$(jq -nc --arg t "$1" --arg a "$2" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:$t,finality:"final",account_id:$a}}')"
}

# check <step> <json> <jq test> <jq line>: ok when the test holds, the line
# says what was checked.
check() {
  local step=$1 json=$2 test=$3 line=$4 text
  text=$(printf '%s' "$json" | jq -r "$line" 2>/dev/null) || text=""
  if [ -z "$json" ]; then text="no answer"
  elif [ -z "$text" ]; then text="unreadable answer: $(printf '%s' "$json" | tr -d '\n' | cut -c1-200)"
  fi
  if printf '%s' "$json" | jq -e "$test" >/dev/null 2>&1; then
    echo "ok $step $text"
  else
    echo "FAIL $step $text"
    failures=$((failures + 1))
  fi
}

# a1. The code hash and the source it was built from.
a1=$(jq -nc --argjson acct "$(query view_account "$HOUSE" | jq -c '.result')" \
  --argjson meta "$(house_view contract_source_metadata '{}')" '{code_hash: $acct.code_hash, link: $meta.link}' 2>/dev/null)
check a1 "$a1" \
  ".code_hash == \"$CODE_HASH\" and .link == \"https://github.com/arkanine1000/atnx-near/tree/$SOURCE_COMMIT\"" \
  '"code_hash \(.code_hash), built from \(.link | split("/") | last | .[0:7])"'

# a2. The vault.
a2=$(house_view get_vault '{}')
check a2 "$a2" \
  '(.assets | tonumber) > 0 and (.reserved | tonumber) <= (.assets | tonumber) and .lp_open == false' \
  '"assets \((.assets | tonumber) / 1e6) USDG, reserved \((.reserved | tonumber) / 1e6), faucet pool \((.faucet_pool | tonumber) / 1e6), lp_open \(.lp_open)"'

# a3. The settings the docs describe.
a3=$(house_view get_config '{}')
check a3 "$a3" \
  '{keeper, treasury, token, fee_bps, finder_bps, lead_min_bps, lead_full_gap_bps, max_open_gap_bps, min_score_e2, cooloff_secs, min_stake, max_stake, min_fill_delay_secs, max_step_bps}
   == {keeper: "keeper.atnx.testnet", treasury: "atnx.testnet", token: "usdg.atnx.testnet", fee_bps: 100, finder_bps: 5000,
       lead_min_bps: 3000, lead_full_gap_bps: 2500, max_open_gap_bps: 1000, min_score_e2: "10000", cooloff_secs: "172800",
       min_stake: "10000000", max_stake: "250000000", min_fill_delay_secs: "5", max_step_bps: 1500}' \
  '"keeper \(.keeper), fee \(.fee_bps) bps, gap limit \(.max_open_gap_bps) bps, stakes \((.min_stake | tonumber) / 1e6) to \((.max_stake | tonumber) / 1e6) USDG, opens_paused \(.opens_paused)"'

# a4. The markets, and which refuse orders now.
markets=$(house_view list_markets '{"limit":100}')
check a4 "$markets" \
  'length > 0 and all(.[]; .opens == true or (.reason | type) == "string")' \
  '"\(length) markets, \([.[] | select(.opens == false)] | length) refusing, each with a reason"'

# a5. One market's two prices, recomputed from S and R with the contract's rule.
a5=$(house_view get_market "{\"market\":$MARKET}" | jq -c '.quote | (.score_e2 | tonumber) as $s | (.reading_e2 | tonumber) as $r | (($r - $s) | fabs) as $d
  | (if $d == 0 then 0 else ($d * 10000 / $s | ceil) end) as $gap
  | (if $gap >= 2500 then 10000 else ([3000 + (7000 * $gap / 2500 | ceil), 10000] | min) end) as $lambda
  | ([($d * $lambda / 10000 | ceil), $d] | min) as $moved | (if $r >= $s then $s + $moved else $s - $moved end) as $lead
  | {s: $s, r: $r, lead: $lead, buy: ([$s, $lead] | max), sell: ([$s, $lead] | min),
     contract: {lead: (.lead_e2 | tonumber), buy: (.buy_e2 | tonumber), sell: (.sell_e2 | tonumber)}}' 2>/dev/null)
check a5 "$a5" \
  '.contract == {lead, buy, sell}' \
  '"market '"$MARKET"': score \(.s), reading \(.r); lead \(.lead), buy \(.buy), sell \(.sell), the same as the contract"'

# a6. A quote for an order, and a refusal.
quote=$(house_view quote_open "{\"market\":$MARKET,\"side\":\"Long\",\"leverage\":2,\"stake\":\"100000000\"}")
buy=$(house_view get_market "{\"market\":$MARKET}" | jq -r '.quote.buy_e2' 2>/dev/null)
refusing=$(printf '%s' "$markets" | jq -r '[.[] | select(.opens == false)][0].id // empty' 2>/dev/null)
refusal='null'
if [ -n "$refusing" ]; then
  refusal=$(house_view quote_open "{\"market\":$refusing,\"side\":\"Long\",\"leverage\":2,\"stake\":\"100000000\"}")
fi
a6=$(jq -nc --argjson q "$quote" --arg buy "$buy" --argjson r "${refusal:-null}" --arg id "$refusing" \
  '{q: $q, buy: $buy, r: $r, id: $id}' 2>/dev/null)
check a6 "$a6" \
  '((.q.allowed == true and .q.entry_e2 == .buy and .q.fee == "1000000" and .q.cost == "101000000" and .q.max_profit == "900000000")
    or (.q.allowed == false and (.q.reason | type) == "string"))
   and (.id == "" or (.r.allowed == false and (.r.reason | type) == "string"))' \
  '(if .q.allowed then "2x UP of 100 on market '"$MARKET"': entry \(.q.entry_e2) (the buy price), fee \((.q.fee | tonumber) / 1e6), cost \((.q.cost | tonumber) / 1e6), max win \((.q.max_profit | tonumber) / 1e6)"
     else "market '"$MARKET"' refuses now: \(.q.reason)" end)
   + (if .id == "" then "; no market refuses now" else "; market \(.id) refused: \(.r.reason)" end)'

# a7. The keeper's recent pushes: the newest is under 15 minutes old.
pushes=$(get "$SITE/api/near/house/pushes?limit=3")
check a7 "$pushes" \
  '(.items | length) > 0 and (now - (.items[0].at | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601)) < 900' \
  '"newest push \(.items[0].txHash), run \(.items[0].run), \(.items[0].accepted) of \(.items[0].quotes) quotes taken, \((now - (.items[0].at | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601)) / 60 | floor) min ago"'

# a8. That push, verified by the site against the public rows.
tx=$(printf '%s' "$pushes" | jq -r '.items[0].txHash // empty' 2>/dev/null)
verify=$(get "$SITE/api/near/house/verify?tx=$tx")
check a8 "$verify" \
  '.ok == true and .rowsFound == .quotes and .hashes.call == .hashes.event and .hashes.event == .hashes.recomputed and (.problems | length) == 0' \
  '"ok \(.ok), \(.rowsFound) rows for \(.quotes) quotes, commitment \(.hashes.recomputed | .[0:16])… in the call, the event and the rows"'

# a9. The hash computed here, against the contract's event read from the RPC.
mine=$(printf '%s' "$verify" | jq -j '.canonical' 2>/dev/null | sha256)
event=$(rpc "$RPC" "$(jq -nc --arg tx "$tx" '{jsonrpc:"2.0",id:1,method:"tx",params:{tx_hash:$tx,sender_account_id:"keeper.atnx.testnet",wait_until:"FINAL"}}')" \
  | jq -r '[.result.receipts_outcome[].outcome.logs[] | select(startswith("EVENT_JSON:")) | ltrimstr("EVENT_JSON:") | fromjson
           | select(.event == "quotes_pushed") | .data[0].commitment][0] // empty' 2>/dev/null)
a9=$(jq -nc --arg mine "$mine" --arg event "$event" '{mine: $mine, event: $event}')
check a9 "$a9" \
  '(.mine | length) == 64 and .mine == .event' \
  '"sha256 here \(.mine | .[0:16])…, in the quotes_pushed event \(.event | .[0:16])…"'

# a10. A dry cross-chain funding quote.
a10=$(get -X POST "$SITE/api/near/intents/quote" -H 'content-type: application/json' -d '{"chain":"sol","amount":"25"}')
check a10 "$a10" \
  '.preview == true and .quote.sendUnits == "25000000" and (.quote.receiveUnits | tonumber) > 0 and .recipient.kind == "placeholder"' \
  '"preview \(.preview): 25 USDC from Solana arrives as \((.quote.receiveUnits | tonumber) / 1e6) on NEAR, recipient \(.recipient.kind)"'

# a11. A trader's account and a relayed order, on chain.
a11=$(jq -nc \
  --argjson acct "$(query view_account "$GUEST" | jq -c '.result')" \
  --argjson keys "$(query view_access_key_list "$GUEST" | jq -c '.result.keys')" \
  --argjson tx "$(rpc "$ARCHIVAL" "$(jq -nc --arg tx "$RELAYED_TX" '{jsonrpc:"2.0",id:1,method:"tx",params:{tx_hash:$tx,sender_account_id:"relayer.atnx.testnet",wait_until:"FINAL"}}')" | jq -c '.result.transaction')" \
  '{amount: $acct.amount, keys: $keys, signer: $tx.signer_id, delegate: $tx.actions[0].Delegate.delegate_action}' 2>/dev/null)
check a11 "$a11" \
  ".amount == \"0\" and (.keys | length) == 1 and .keys[0].access_key.permission.FunctionCall.receiver_id == \"$HOUSE\"
   and .signer == \"relayer.atnx.testnet\" and .delegate.sender_id == \"$GUEST\" and .delegate.receiver_id == \"$HOUSE\"
   and .delegate.public_key == .keys[0].public_key and .delegate.actions[0].FunctionCall.method_name == \"open\"
   and .delegate.actions[0].FunctionCall.deposit == \"0\"" \
  '"\(.delegate.sender_id): \(.amount) NEAR, one function-call key for \(.keys[0].access_key.permission.FunctionCall.receiver_id); its \(.delegate.actions[0].FunctionCall.method_name), signed with that key, sent and paid for by \(.signer), deposit \(.delegate.actions[0].FunctionCall.deposit)"'

if [ "$failures" -gt 0 ]; then
  echo "$failures of 11 steps failed"
  exit 1
fi
