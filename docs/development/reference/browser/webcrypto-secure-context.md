# Web Crypto 安全上下文限制：外部资料摘录（reference）

> 本文件为外部技术资料的直接摘录（原文或原文翻译），不做主观加工，用于支撑 `docs/development/research/20260906-crypto-randomuuid-secure-context.md` 中的调查结论。
>
> 摘录格式：英文原文摘录自各页面，关键段落附中文译文（以「译」标注）。所有资料获取日期均为 **2026-09-06**，除非单独注明。

- [1. Crypto.randomUUID()（MDN）](#1-cryptorandomuuid-mdn)
- [2. Crypto.getRandomValues()（MDN）](#2-cryptogetrandomvalues-mdn)
- [3. 来源链接汇总](#3-来源链接汇总)

---

## 1. Crypto.randomUUID()（MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID>（获取日期 2026-09-06）

> **Secure context:** This feature is available only in [secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts) (HTTPS), in some or all supporting browsers.
>
> 译：安全上下文：该特性仅在安全上下文（HTTPS）中可用（视具体浏览器而定）。
>
> The **`randomUUID()`** method of the [`Crypto`](https://developer.mozilla.org/en-US/docs/Web/API/Crypto) interface is used to generate a v4 [UUID](https://developer.mozilla.org/en-US/docs/Glossary/UUID) using a cryptographically secure random number generator.
>
> 译：`Crypto` 接口的 `randomUUID()` 方法使用密码学安全随机数生成器生成 v4 UUID。

规范：Web Cryptography Level 2 §[Crypto-method-randomUUID](https://w3c.github.io/webcrypto/#Crypto-method-randomUUID)。

## 2. Crypto.getRandomValues()（MDN）

来源：<https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues>（获取日期 2026-09-06）

> `getRandomValues()` is the only member of the `Crypto` interface which can be used from an insecure context.
>
> 译：`getRandomValues()` 是 `Crypto` 接口中唯一可以在非安全上下文中使用的方法。
>
> The **`Crypto.getRandomValues()`** method lets you get cryptographically strong random values. The array given as the parameter is filled with random numbers (random in its cryptographic meaning).
>
> 译：`Crypto.getRandomValues()` 方法用于获取密码学强度的随机值；传入的数组会被随机数填充（密码学意义上的随机）。
>
> **Return value**: The same array passed as `typedArray` but with its contents replaced with the newly generated random numbers. Note that `typedArray` is modified in-place, and no copy is made.
>
> 译：返回值：传入的 `typedArray` 本身，其内容已被新生成的随机数替换。注意 `typedArray` 是原地修改，不会产生副本。

## 3. 来源链接汇总

- MDN Crypto.randomUUID()：<https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID>
- MDN Crypto.getRandomValues()：<https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues>
- MDN 安全上下文（Secure contexts）：<https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts>
- Web Cryptography Level 2 规范：<https://w3c.github.io/webcrypto/>
