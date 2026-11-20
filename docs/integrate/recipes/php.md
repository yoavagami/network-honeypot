### PHP (plain PHP, Laravel, Symfony, WooCommerce custom code)

1. Add the tag (step 3) to your layout template (`header.php`, Blade layout, Twig base template).
2. Add this helper (also at `{{TAG_BASE}}/integrate/v1/uhoney.php`) and call `uhoney_assess()` before charging:

{{snippet:php/uhoney.php}}

Behind a load balancer, make sure `REMOTE_ADDR` is the visitor's IP (trusted proxy settings).
