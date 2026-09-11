<!-- setup-guide: {"auth_modes":["local_api"],"provider":"jd_jos","entry_url":"https://open.jd.com/","catalog_reviewed_at":"2026-09-09","sources":["https://jos.jd.com/platformdetail?listId=0&itemId=2291"]} -->
# jd-seller

## Entry
[JD Merchant Open Platform](https://open.jd.com/) → developer console → app management. JOS onboarding has migrated here; select the existing migrated application when present.

## Configure
New applications require an enterprise account and the qualifications for the selected category. Self-developed merchant apps require software-copyright qualification or an accepted exception; POP eligibility is restricted. Check the current category requirements, merchant linkage and approved APIs before applying. Configure the supplied callback, then continue through the protected merchant authorization flow.

## Credentials
Use [[field:app_key]] and [[field:app_secret]] from the selected app details. The portal migration alone does not require replacing existing credentials or changing API/OAuth endpoints.

## Verify
Read merchant/product data using a described read operation. Missing business/operations approval must be identified explicitly, not treated as a bad secret.
