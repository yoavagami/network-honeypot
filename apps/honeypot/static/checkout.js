(function () {
  "use strict";
  var TEST_CARDS = {
    "4242424242424242": ["visa", "approved"],
    "4000056655665556": ["visa", "approved"],
    "5555555555554444": ["mastercard", "approved"],
    "2223003122003222": ["mastercard", "approved"],
    "378282246310005": ["amex", "approved"],
    "4000000000000002": ["visa", "declined"],
    "4000000000009995": ["visa", "insufficient_funds"]
  };
  var form = document.getElementById("payment-form");
  if (!form) return;
  var num = document.getElementById("cc-number");
  var exp = document.getElementById("cc-exp");
  var cvc = document.getElementById("cc-cvc");
  var name = document.getElementById("cc-name");
  var err = form.querySelector(".card-error");
  function digits(s) { return (s || "").replace(/\D/g, ""); }
  function luhn(n) {
    var sum = 0, alt = false;
    for (var i = n.length - 1; i >= 0; i--) {
      var d = +n[i];
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return n.length >= 12 && sum % 10 === 0;
  }
  function brandOf(n) {
    if (/^4/.test(n)) return "visa";
    if (/^(5[1-5]|2[2-7])/.test(n)) return "mastercard";
    if (/^3[47]/.test(n)) return "amex";
    return "unknown";
  }
  function set(nameAttr, value) { var el = form.querySelector('input[name="' + nameAttr + '"]'); if (el) el.value = value; }
  function showError(msg) { if (err) { err.textContent = msg; err.hidden = false; } }
  if (num) num.addEventListener("input", function () {
    var d = digits(num.value).slice(0, 19);
    num.value = d.replace(/(.{4})/g, "$1 ").trim();
  });
  if (exp) exp.addEventListener("input", function () {
    var d = digits(exp.value).slice(0, 4);
    exp.value = d.length > 2 ? d.slice(0, 2) + " / " + d.slice(2) : d;
  });
  if (cvc) cvc.addEventListener("input", function () { cvc.value = digits(cvc.value).slice(0, 4); });

  form.addEventListener("submit", function () {
    var method = form.querySelector('input[name="method"]:checked');
    if (!method || method.value !== "test_card") return;
    var n = digits(num && num.value);
    var e = digits(exp && exp.value);
    var c = digits(cvc && cvc.value);
    var filled = [n ? "number" : "", e ? "expiry" : "", c ? "cvc" : "", name && name.value.trim() ? "name" : ""].filter(Boolean).join(",");
    set("card_fields_filled", filled);
    set("card_number_length", String(n.length));
    set("card_luhn_valid", String(luhn(n)));
    var month = +e.slice(0, 2), year = 2000 + +e.slice(2, 4);
    var now = new Date();
    var expiryOk = e.length === 4 && month >= 1 && month <= 12 && (year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1));
    if (!n || !expiryOk || c.length < 3) {
      set("card_result", "incomplete");
      return;
    }
    var test = TEST_CARDS[n];
    set("card_brand", test ? test[0] : brandOf(n));
    if (test) {
      set("card_result", test[1] + "_test");
      set("card_last4", n.slice(-4));
    } else {
      // Not a test card: only the shape of what was typed is posted, never the number.
      set("card_result", "rejected_non_test");
      set("card_last4", "");
    }
    if (num) num.value = "";
    if (cvc) cvc.value = "";
  });
})();
