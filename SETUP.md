# Dynox Order Tracking — setup (about 30 minutes)

Customers open **dynoxhome.com/apps/track**, type their order number + email, and see each production step.
The page appears inside your store's theme, so it works with any theme.

You need: the Shopify store owner login, a free GitHub account, a Render account (render.com).

---

## 1. Put the code on GitHub
1. github.com → **New repository** → name `dynox-order-tracking` → **Private** → Create.
2. **Add file → Upload files** → drag in everything from this folder (server.js, package.json, config, views, test, SETUP.md, shopify.app.toml) → **Commit**.

## 2. Create the app in Shopify
1. Go to **dev.shopify.com** and sign in with the **same account that owns the store** (the app and the store must be in the same organization).
2. **Apps → Create app → Start from Dev Dashboard** → name it `Dynox Order Tracking`.
3. Open **Settings** and copy the **Client ID** and **Client secret** (you need them in step 3).

## 3. Put the app online (Render)
1. render.com → **New → Web Service** → connect the GitHub repo.
2. Runtime **Node** · Build command `npm install` · Start command `npm start`.
3. Plan: **Starter** recommended. (Free works, but sleeps when idle, so the first check can take ~50 seconds.)
4. **Environment variables**:
   | Key | Value |
   |---|---|
   | `SHOPIFY_SHOP` | your store's myshopify name, e.g. `dynox-home` (Shopify admin → Settings → Domains shows `xxx.myshopify.com`) |
   | `SHOPIFY_CLIENT_ID` | from step 2 |
   | `SHOPIFY_CLIENT_SECRET` | from step 2 |
   | `DEBUG_KEY` | any long random text, e.g. `dx-7f3k29qplm` |
5. Create. When it's live, copy its address, e.g. `https://dynox-order-tracking.onrender.com`. Opening it should say *"Dynox Order Tracking is running."*

## 4. Configure + install the app
In the Dev Dashboard → your app → **Versions → Create a version**:
- **App URL**: your Render address
- **Access scopes**: `read_orders`, `read_all_orders`, `write_app_proxy`
- **App proxy**: Prefix `apps` · Subpath `track` · Proxy URL `https://YOUR-APP.onrender.com/proxy`
- **Release** the version.

Then click **Install app** and choose the Dynox store. Approve the permissions.

## 5. Connect it to the boss's production data
1. Open: `https://YOUR-APP.onrender.com/debug?key=YOUR_DEBUG_KEY&order=1042` (use a real made-to-order order number).
2. You'll see every metafield on that order. Look for the production dates (e.g. `mto.in_production_date`).
3. In GitHub, edit **config/steps.json** and put each metafield name next to its step, e.g.
   `{ "name": "Container loaded", "metafield": "mto.container_loaded_date" }`.
   If there's one field with the current step's name, put it in `"statusMetafield"`. If there's an ETA field, put it in `"etaMetafield"`. Commit → Render redeploys automatically.
4. Check the `preview` part of the debug page — it shows exactly what the customer will see.

**If no production fields show up**, the boss's app keeps the data only inside itself. Send him:
> "Can dynox-mto also save each step's date on the order as metafields (e.g. namespace `mto`, keys `confirmed_date`, `production_date`, `container_loaded_date`, `ocean_shipping_date`, `arrived_us_date`, `warehouse_date`, `delivered_date`)? Please use a normal namespace, not `$app`, so our tracking app can read them."

Until then, the page still works: it shows *Order confirmed* (order date), *In production* as the current step, and *Final delivery* once the order is fulfilled in Shopify.

## 6. Add the link for customers
- The new theme (v7) already has **Track your order** in the header, pointing to `/apps/track`.
- For any other theme or the footer: **Online Store → Navigation** → add menu item **Track your order** → link `/apps/track`.

## 7. Test
Open `dynoxhome.com/apps/track`, enter a real order number + its email. A wrong email shows "We couldn't find that order" (on purpose, so nobody can look up other people's orders).

---

### How it works / safety
- Every request from the store is signed by Shopify; the app rejects unsigned requests.
- The order is only shown if the email matches the order's email.
- Max 20 lookups per visitor per 10 minutes.
- The app only **reads** orders. It never changes anything in the store.
- Local test: `npm test`.
