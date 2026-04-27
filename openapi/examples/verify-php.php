<?php
/**
 * 可运行的 PHP 示例：直接嵌入 Laravel / Symfony / 原生处理器。
 *
 * 冒烟测试运行方式：
 *   php openapi/examples/verify-php.php
 */

const MAX_AGE = 300; // seconds — must match Kitora's window

/**
 * 验证 X-Kitora-Signature 请求头与原始请求体是否匹配。
 *
 * @param string $header  完整的 X-Kitora-Signature 请求头值。
 * @param string $body    原始请求体字节。
 * @param string $secret  Webhook 签名密钥（whsec_...）。
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
