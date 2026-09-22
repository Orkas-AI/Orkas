<!-- setup-guide: {"auth_modes":["local_api"],"provider":"qoo10_japan","catalog_reviewed_at":"2026-09-16","sources":["https://api.qoo10.jp/GMKT.INC.Front.QAPIService/Document/QAPIGuideIndex.aspx"]} -->
# Qoo10 Japan

## Entry
This connection uses the Japanese Qoo10 seller QAPI. It requires seller API access; a shopper account or another regional Qoo10 API does not supply these credentials.

## Configure
The official QAPI platform issues a Seller Authorization Key, also called Certification Key. The developer API ID alone is not the seller key. Issuance takes place on the provider platform.

## Credentials
[[field:certification_key]] is encrypted on this device. The connector does not collect the shop login password. Expired or revoked keys require reconnecting with a valid key.

## Verify
Connection validates the key with a product-list read. Order permissions remain provider-controlled. Product pages include provider totals; order reads cover one Japan calendar day, defaulting to pending shipping states 1–3. States 4 (shipped) and 5 (delivered) can be selected explicitly. Stock updates target one existing combination option using its exact names, values and option code.

The official guide includes QAPI Test Form. It uses the selected API host and seller key; the form is not evidence of an isolated sandbox. A read can validate access before stock changes. Updates may take up to ten minutes to appear on product pages.
