# Channel export mapping

Use actual source columns and documentation. Keep a mapping table: original field → business concept → transformation → known ambiguity. Do not force every file into an invented universal schema.

| Channel family | Distinctions to resolve |
| --- | --- |
| Taobao/Tmall, JD, Pinduoduo | Placed/paid/shipped/settled order states; item/SKU; subsidies, coupons and refunds |
| Douyin/Kuaishou, TikTok Shop | Product/order versus live/creator/ad reports; attributed versus settled sales; returns and revenue reversals |
| Amazon, Walmart | Sales/order reports versus settlements, fulfillment charges and ads attribution; parent/child and seller offers |
| Shopify/WooCommerce | Order and line aggregates, payment/refund events, sales reversals and inventory; store/plugin report definitions |
| Shopee/Lazada, AliExpress | Country/currency, variation, vouchers, shipping subsidies, return/refund and settlement dates |
| eBay/Etsy | Order versus line, variations, fees, payment/refund dates and shipping revenue |

The same mapping applies to other platforms when their fields are supplied. These are material-analysis routes, not verified online integrations. For current exact schemas consult the source platform's official documentation or the exported report's data dictionary. Unknown fields stay unmapped until resolved.
