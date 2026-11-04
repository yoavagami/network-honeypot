(function () {
  "use strict";
  // Stripe test mode Payment Element (see src/shop/stripeTest.ts). Card data stays inside Stripe's
  // iframe and is confirmed with Stripe directly; only the PaymentIntent id (and, on failure, the
  // Stripe error code) is posted to /checkout/pay, where the server re-checks the outcome with Stripe.
  var form = document.getElementById("payment-form");
  var mount = document.getElementById("stripe-payment-element");
  if (!form || !mount) return;
  var errBox = mount.parentNode.querySelector(".card-error");
  var payButton = document.getElementById("pay-button");
  var stripe = null, elements = null, ready = false, submitting = false;

  function set(name, value) { var el = form.querySelector('input[name="' + name + '"]'); if (el) el.value = value; }
  function showError(msg) { if (errBox) { errBox.textContent = msg; errBox.hidden = !msg; } }
  function selected() { var m = form.querySelector('input[name="method"]:checked'); return m && m.value === "stripe_test"; }

  if (typeof window.Stripe !== "function") {
    mount.innerHTML = "";
    showError("The card form could not be loaded. Please refresh or choose another method.");
    return;
  }

  fetch("/checkout/stripe/intent", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (r) { if (!r.ok) throw new Error("intent " + r.status); return r.json(); })
    .then(function (d) {
      stripe = window.Stripe(d.publishableKey);
      elements = stripe.elements({ clientSecret: d.clientSecret, appearance: { theme: "stripe", variables: { colorPrimary: "#b7791f" } } });
      mount.innerHTML = "";
      var pe = elements.create("payment", { layout: "tabs" });
      pe.on("ready", function () { ready = true; });
      pe.mount(mount);
    })
    .catch(function () {
      mount.innerHTML = "";
      showError("Card payments are unavailable right now. Please choose another method.");
    });

  form.addEventListener("submit", function (ev) {
    if (!selected() || submitting) return;
    ev.preventDefault();
    showError("");
    if (!stripe || !elements || !ready) { showError("The card form is still loading. Please wait a moment."); return; }
    submitting = true;
    if (payButton) payButton.disabled = true;
    stripe
      .confirmPayment({
        elements: elements,
        redirect: "if_required",
        confirmParams: { return_url: location.origin + "/checkout/payment" }
      })
      .then(function (res) {
        var pi = res.paymentIntent || (res.error && res.error.payment_intent) || null;
        set("stripe_payment_intent", pi && pi.id ? pi.id : "");
        set("stripe_client_error", res.error ? String(res.error.code || res.error.type || "error") : "");
        // Post every attempt (including empty / invalid fields that never reached Stripe) so the
        // server records it and shows the right message.
        HTMLFormElement.prototype.submit.call(form);
      })
      .catch(function () {
        set("stripe_client_error", "confirm_failed");
        HTMLFormElement.prototype.submit.call(form);
      });
  });
})();
