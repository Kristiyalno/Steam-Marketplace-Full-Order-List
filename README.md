# Steam Marketplace Full Order List

A Chrome extension for the Steam Community Market. Item pages only show the
first handful of buy and sell orders, then collapse the rest into a single
"$X or more" / "$X or lower" row. This extension makes that row clickable and
expands it into the full order list, in place, styled to match the rest of
the page.

## Features

- Expands the collapsed row into every remaining price level and quantity
- Buy orders sort highest price first, sell orders sort lowest price first,
  matching how Steam already orders the native rows
- Adds a total row (combined value and quantity across every order)
- Reads whatever currency Steam is already displaying and formats the total
  the same way, instead of assuming USD
- Injected rows are cloned from Steam's own row markup, so fonts, spacing,
  and theme all match without any hardcoded styles
- Click again to collapse

## Install (unpacked, for now)

1. Download or clone this repository.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Open any Steam Community Market item page and click the collapsed row at
   the bottom of the buy or sell table.

## How it works

Steam embeds the full compact order list (`rgCompactBuyOrders` /
`rgCompactSellOrders`) in the page's own data, it's just not rendered beyond
the first few rows. The extension reads that data directly, so no network
requests are made and no external server is involved.

Because the data comes from the page as loaded, expanding the row shows a
snapshot from page load rather than a live order book. Refresh the page for
current data.

## Permissions

Runs only on `steamcommunity.com/market/listings/*`. No other host access,
no background scripts, and nothing is sent anywhere.

## License

Non-commercial, attribution required, share-alike. See [LICENSE](https://github.com/Kristiyalno/Steam-Marketplace-Full-Order-List/blob/main/LICENSE).
