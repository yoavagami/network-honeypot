## 3. Add the tag to every page

Put the tag in the shared layout, so it loads on every page including checkout:

{{snippet:browser/tag.html}}

- The first line is a tiny stub so `uhoney.track()` calls made before the tag loads are not lost.
- With test keys the tag works on `localhost` and `127.0.0.1`. For any other domain, add it in the dashboard (Settings → Domains) first.
- **Content Security Policy:** if your site sends one, allow `{{TAG_HOST}}` in `script-src` and `{{API_HOST}}` in `connect-src`. A blocked tag fails silently; this is the most common integration problem.
- **Consent:** if you need consent before analytics, add `data-consent="pending"` to the script tag and call `uhoney.consent(true)` when the visitor agrees. Nothing is sent before that.

**Check:** open any page of your site, then run the status call from step 2: `tag_seen` and `token_issued` pass.
