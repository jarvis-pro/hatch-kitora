<?php
/**
 * Runnable PHP example: drop into a Laravel / Symfony / vanilla handler.
 *
 * Run as a smoke test:
 *   php openapi/examples/verify-php.php
 */

const MAX_AGE = 300; // seconds — must match Kitora's window

/**
 * Verify the X-Kitora-Signature header against the raw request body.
 *
 * @param string $header  The full X-Kitora-Signature header value.
 * @param string $body    The raw request body bytes.
 * @param string $secret  The webhook signing secret (whsec_...).
 * @return bool
 */
function verify_kitora_signature(string $header, string $body, string $secret): bool {
    $parts = [];
    foreach (explode(',', $header) as $pair) {
        $segments = array_map('trim', explode('=', $pair, 2));
        if (count($segments) === 2) {
            $parts[$segments[0]] = $segments[1];
        }
    }
    if (!isset($parts['t'], $parts['v1'])) {
        return false;
    }
    $t = (int) $parts['t'];
    if (abs(time() - $t) > MAX_AGE) {
        return false;
    }
    $expected = hash_hmac('sha256', $t . '.' . $body, $secret);
    return hash_equals($expected, $parts['v1']);
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    $secret = 'whsec_test_secret';
    $body = '{"id":"evt_1","type":"subscription.created"}';
    $t = time();
    $v1 = hash_hmac('sha256', $t . '.' . $body, $secret);
    $header = "t={$t},v1={$v1}";
    echo verify_kitora_signature($header, $body, $secret) ? "OK\n" : "FAIL\n";
}
