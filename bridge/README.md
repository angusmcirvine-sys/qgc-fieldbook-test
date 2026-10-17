# QGC Xero Bridge

Server-side bridge for the **qgc-fieldbook-xero** branch.

## What it does

- Uses Xero OAuth 2.0 authorization-code flow.
- Stores Xero access/refresh tokens in a private Cloudflare KV namespace.
- Matches a Fieldbook job to a Xero contact by the property's address.
- Creates an ACCREC invoice with `Status: DRAFT`.
- Returns a Xero deep link for the exact draft invoice so the iPhone browser can open it immediately.
- Keeps Xero client secrets and refresh tokens out of GitHub Pages.

## QGC billing rules currently encoded

- Labour: NZD 65/hour.
- Ride-on mower: NZD 95/hour.
- Green-waste run: 0.5 hour at NZD 65/hour when waste is selected.
- Green-waste fixed fee: NZD 37 for <=100kg; NZD 74 for 100–200kg.
- 200kg+ waste fee is deliberately left configurable as `WASTE_LARGE_RATE`.
- Dump travel: NZD 2/km.
- Spray: NZD 16 per 15L application.
- Ride-on hours are removed from ordinary labour hours by the Fieldbook front end to avoid double-charging the operator time.

## One-time deployment

1. Create a Cloudflare Worker and KV namespace.
2. Deploy `worker.js` and bind the KV namespace as `XERO_STORE`.
3. Set Worker secrets:
   - `XERO_CLIENT_ID`
   - `XERO_CLIENT_SECRET`
   - `XERO_REDIRECT_URI` (the Worker URL ending in `/callback`)
4. Optional variables:
   - `SALES_ACCOUNT_CODE` if you want invoice rows pre-coded to a Xero sales account.
   - `WASTE_LARGE_RATE` once the QGC fixed rate for 200kg+ is confirmed.
5. In the Xero developer app, add the exact Worker `/callback` URL as the OAuth redirect URI.
6. Open the Fieldbook Xero page, enter the Worker base URL, tap **Save**, then **Connect Xero**.
7. Authorise the QGC Xero organisation once.

After connection, the iPhone workflow is:

Calendar/Reminders -> QGC Truck Shortcut -> Fieldbook -> tick/edit completed work -> set charges -> **Create Xero Draft & Open Xero** -> review draft in Xero -> approve/send manually.

## Safety

The bridge only creates DRAFT invoices. It does not authorise, approve, email or submit invoices to customers.
