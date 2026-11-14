#!/usr/bin/env python3
"""Today's Cloudflare Workers + Durable Objects usage against the free plan's daily limits.

Run it yourself (it reads your API token from ~/Developer/Cloudflare API Token.rtf and never prints it):
    python3 ~/Developer/fbca-tv-site/tools/cf-usage.py

Or pass the token in an environment variable instead:  CF_API_TOKEN=... python3 cf-usage.py
The token needs "Account Analytics: Read". Free-plan daily limits reset at 00:00 UTC (6:00 PM Central in
winter, 7:00 PM in summer), so "today" here is the UTC day.
"""
import datetime, json, os, re, subprocess, sys, urllib.request

ACCOUNT = '625a41b52a5758917b0d9cffb99ffec9'
TOKEN_FILE = os.path.expanduser('~/Developer/Cloudflare API Token.rtf')
LIMITS = {'requests': 100_000, 'do_requests': 100_000, 'do_gb_s': 13_000}


def verified(tok):
    """True if Cloudflare accepts this token (a user token, or one owned by the account)."""
    for url in ('https://api.cloudflare.com/client/v4/user/tokens/verify',
                f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/tokens/verify'):
        try:
            req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + tok})
            with urllib.request.urlopen(req, timeout=20) as r:
                if json.loads(r.read()).get('success'):
                    return True
        except Exception:
            pass
    return False


def token():
    if os.environ.get('CF_API_TOKEN'):
        return os.environ['CF_API_TOKEN'].strip()
    text = subprocess.run(['textutil', '-convert', 'txt', '-stdout', TOKEN_FILE], capture_output=True, text=True).stdout
    # Token-like strings of any usual length; the first one Cloudflare accepts is used. Never printed.
    found = list(dict.fromkeys(re.findall(r'(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{30,100}(?![A-Za-z0-9_.-])', text)))
    for cand in found:
        if verified(cand):
            return cand
    lengths = ', '.join(str(len(c)) for c in found) or 'none'
    sys.exit(f'No working API token found in {TOKEN_FILE}: {len(found)} token-like strings '
             f'(lengths: {lengths}), none accepted by Cloudflare. Set CF_API_TOKEN instead, or check the token is active.')


def gql(tok, query, variables):
    body = json.dumps({'query': query, 'variables': variables}).encode()
    req = urllib.request.Request('https://api.cloudflare.com/client/v4/graphql', data=body,
                                 headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    if d.get('errors'):
        return None, '; '.join(e.get('message', '?') for e in d['errors'])
    return d['data']['viewer']['accounts'][0], None


def main():
    tok = token()
    now = datetime.datetime.now(datetime.timezone.utc)
    day = now.strftime('%Y-%m-%d')
    start, end = day + 'T00:00:00Z', now.strftime('%Y-%m-%dT%H:%M:%SZ')
    resets = (now.replace(hour=0, minute=0, second=0, microsecond=0) + datetime.timedelta(days=1)).astimezone()
    print(f'Cloudflare usage for the UTC day {day} (resets {resets:%a %-I:%M %p %Z}, local time)\n')

    acct, err = gql(tok, '''query($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: {accountTag: $a}) {
        workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: $s, datetime_leq: $e}) { sum { requests errors } dimensions { scriptName } } } } }''',
        {'a': ACCOUNT, 's': start, 'e': end})
    if err:
        print('Workers requests: could not read (' + err + ')')
    else:
        rows = acct['workersInvocationsAdaptive']
        total = sum(r['sum']['requests'] for r in rows)
        print(f"Workers requests today: {total:,} of {LIMITS['requests']:,}  ({100 * total / LIMITS['requests']:.1f}%)  -> {LIMITS['requests'] - total:,} left")
        for r in sorted(rows, key=lambda r: -r['sum']['requests']):
            print(f"   {r['dimensions']['scriptName']:<22} {r['sum']['requests']:>8,} requests  {r['sum']['errors']:>5,} errors")

    acct, err = gql(tok, '''query($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: {accountTag: $a}) {
        durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {datetime_geq: $s, datetime_leq: $e}) { sum { requests } }
        durableObjectsPeriodicGroups(limit: 1000, filter: {datetime_geq: $s, datetime_leq: $e}) { sum { activeTime inboundWebsocketMsgCount outboundWebsocketMsgCount } max { activeWebsocketConnections } } } } }''',
        {'a': ACCOUNT, 's': start, 'e': end})
    if err:
        print('\nDurable Objects: could not read (' + err + ')')
    else:
        req = sum(r['sum']['requests'] for r in acct['durableObjectsInvocationsAdaptiveGroups'])
        per = acct['durableObjectsPeriodicGroups']
        active_us = sum(r['sum']['activeTime'] for r in per)
        gb_s = active_us / 1e6 * 0.125  # 128 MB per object while it's awake
        msgs_in = sum(r['sum']['inboundWebsocketMsgCount'] for r in per)
        msgs_out = sum(r['sum']['outboundWebsocketMsgCount'] for r in per)
        peak = max((r['max']['activeWebsocketConnections'] for r in per), default=0)
        billed = req + msgs_in / 20  # incoming WebSocket messages count 1 per 20
        print(f"\nDurable Objects requests today: {req:,} (+ {msgs_in:,} incoming WebSocket messages = {billed:,.0f} billed) of {LIMITS['do_requests']:,}  ({100 * billed / LIMITS['do_requests']:.1f}%)")
        print(f"Durable Objects duration today: {gb_s:,.1f} GB-s of {LIMITS['do_gb_s']:,}  ({100 * gb_s / LIMITS['do_gb_s']:.1f}%)")
        print(f"WebSocket messages sent to viewers: {msgs_out:,} (free)  |  most live connections at once: {peak:,}")


if __name__ == '__main__':
    main()
