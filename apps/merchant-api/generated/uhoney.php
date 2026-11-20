<?php
// uhoney.php — server helper for the uHoney merchant API (PHP 7.4+, curl).
// Reads UHONEY_SECRET_KEY and UHONEY_WEBHOOK_SECRET from the environment.

const UHONEY_FORWARD_HEADERS = [
    'accept', 'accept-language', 'accept-encoding',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
    'signature', 'signature-input', 'signature-agent',
];

/**
 * Verdict before charging. Fails open: returns null on any error or after 300 ms.
 * $order = ['id' => 'ord_1', 'amount' => 12900, 'currency' => 'EUR'] (amount in cents).
 */
function uhoney_assess(array $order, ?string $sessionToken, int $timeoutMs = 300): ?array
{
    $secret = getenv('UHONEY_SECRET_KEY');
    if (!$secret) return null;
    $api = getenv('UHONEY_API_URL') ?: '{{API_URL}}';
    $headers = [];
    foreach (UHONEY_FORWARD_HEADERS as $name) {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        if (!empty($_SERVER[$key])) $headers[$name] = substr((string) $_SERVER[$key], 0, 4096);
    }
    $body = [
        'stage' => 'pay',
        'order' => ['id' => (string) $order['id'], 'amount' => (int) $order['amount'], 'currency' => strtoupper($order['currency'])],
        'request' => [
            'ip' => $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0',
            'user_agent' => $_SERVER['HTTP_USER_AGENT'] ?? null,
            'method' => $_SERVER['REQUEST_METHOD'] ?? null,
            'path' => strtok($_SERVER['REQUEST_URI'] ?? '/', '?'),
            'host' => $_SERVER['HTTP_HOST'] ?? null,
            'headers' => (object) $headers,
        ],
    ];
    if (is_string($sessionToken) && strpos($sessionToken, 'st_') === 0) $body['session_token'] = $sessionToken;

    $ch = curl_init($api . '/v1/assess');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT_MS => $timeoutMs,
        CURLOPT_CONNECTTIMEOUT_MS => $timeoutMs,
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . $secret,
            'Content-Type: application/json',
            'Idempotency-Key: ' . $order['id'],
        ],
        CURLOPT_POSTFIELDS => json_encode($body),
    ]);
    $response = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($response === false || $status < 200 || $status >= 300) return null;
    $data = json_decode($response, true);
    return is_array($data) ? $data : null;
}

/** Check a webhook's Uhoney-Signature header against the raw body (file_get_contents('php://input')). */
function uhoney_verify_webhook(string $rawBody, ?string $signatureHeader, int $toleranceSec = 300): bool
{
    $secret = getenv('UHONEY_WEBHOOK_SECRET');
    if (!$secret || !$signatureHeader || !preg_match('/^t=(\d+),v1=([0-9a-f]{64})$/', $signatureHeader, $m)) return false;
    if (abs(time() - (int) $m[1]) > $toleranceSec) return false;
    return hash_equals(hash_hmac('sha256', $m[1] . '.' . $rawBody, $secret), $m[2]);
}

// In your checkout handler, before charging:
//   $assessment = uhoney_assess(['id' => $orderId, 'amount' => $totalCents, 'currency' => 'EUR'], $_POST['uhoney_token'] ?? null);
//   save $assessment['assessment_id'], $assessment['driver'], $assessment['suggested_action'] on the order (if not null)
//   ...continue the payment exactly as before.
