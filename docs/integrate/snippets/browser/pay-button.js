// When the visitor presses Pay (before your own submit/redirect logic):
payButton.addEventListener("click", () => {
  window.uhoney.track("pay_clicked", { orderId: currentOrderId });
});

// Classic <form method="post"> checkouts get a hidden uhoney_token field automatically.
// Custom (fetch/JSON) checkouts: send the token yourself.
const sessionToken = window.uhoney.token ? window.uhoney.token() : null;
await fetch("/api/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...checkoutData, uhoney_token: sessionToken }),
});
