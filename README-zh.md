# dsh-preclaim

**提交信息里写「测试通过」是一个主张。这个插件拿它跟本次会话真正跑过的东西比对 ——
对不上就拦下来。**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。
**不调模型、不连服务、不联网、不需要 API key。**

```
$ git commit -m "fix: parser handles empty input; tests pass"

  dsh-preclaim: 本次会话没有记录到任何证据，所以这道门分不清
  「它没有发生」和「我没有看见它发生」
  —— 主张的是：CLAIM_TEST_PASSED

  [review] 照常提交，还是先把测试跑一遍？
```

> **为什么叫 `preclaim` 而不是 `evidence-gate`？** 因为显眼的名字都被别人占了，
> 其中几个做的是同一个题目：`dsh-evidence-gate`（lory.top）、`dsh-evidence`（tudamu）、
> `dsh-claim-gate`、`dsh-attest`。本项目的设计文档查过注册表，选了一个空闲且
> 描述对了时机（**主张落盘之前**）的名字。若日后有人改回别人持有的名字，
> `scripts/verify-artifacts.mjs` 会让构建失败。

## 为什么它不是一个模型

它要拦的失败**不是判断题**。「信息里声称测试通过」和「本次会话没有测试运行的记录」
都是事实，两者是否一致是可判定的。在这里放一个模型，等于给一个答案是
是/否的问题加上置信区间，而且它偶尔会以没人能复现的方式出错。

所以整个插件是确定性的：

* **`tools/post-execute` 把跑过的东西记进会话内存台账**；
* **`tools/pre-execute` 在被门管的动作执行前读那份台账**。

这个切分带来三条结论，它们是设计本身而不是实现细节：

1. **主张不能自证。** 被检查的动作从不被当作证据来源。提交信息里写
   「ran pytest; all tests pass」对它自己的检查**没有任何贡献**。
2. **跑挂了的测试不能当证据。** `test-run` 与 `build-run` 要求成功；
   `ci-check` 和 `file-read` 不要求 —— 看到 CI 是红的仍然是「看过 CI 状态」，
   读文件这件事成不成立与退出码无关。
3. **不从散文里推断。** 台账里只有主机报告过的东西。不读 transcript，不做启发式扫描。

## 安装

```sh
dsh plugin --profile <name> add dsh-preclaim@0.1.2
```

bundle 补丁在激活时即武装。**每个键都有默认值**，零配置就能用。

## 门管什么

**shell 调用**里出现断言性 git 动词 —— `commit`、`push`、`tag`。
commit 的信息就在命令里；push 是通过它携带的提交来断言的，所以这一层查命令文本，
提交范围留给人工。

只读动词（`status`、`log`、`diff`、`show`、`branch`、`rev-parse` …）永不门管，
`--dry-run`、`--help`、`-h`、`--version` 也不门管：它们都不产生持久主张。
`git fetch && git commit -m x` 只门管 commit，不管 fetch。

**README 类写入** —— `README*`、`CHANGELOG*`、`docs/**/*.md`、`**/README.md`。
README 是项目声明「我做什么、它能不能跑」的地方。普通源码写入不管，
否则等于给每一次编辑都加一道门。工作目录之外的写入**完全不判**。

## 什么算主张

| 模式 | 它注意到什么 | 由什么回答 |
|---|---|---|
| `CLAIM_TEST_PASSED` | 说测试通过 | 一次记录在案的测试运行 |
| `CLAIM_VERIFIED` | 说某事已验证 | **没有任何可观察证据** → `tool_unverified` |
| `CLAIM_RAN_CHECK` | 说跑过某个检查 | 一次记录在案的测试运行 |
| `CLAIM_BUILD_OK` | 说构建成功 | 一次记录在案的构建 |
| `CLAIM_CLI_ASSERTION` | 点名一个 CLI 调用 | 一次 CI 观察 |
| `CLAIM_DEPENDENCY` | 声称平台依赖 | **没有任何可观察证据** → `tool_unverified` |
| `CLAIM_LINE_REF` | 引用行号 | 一次文件读取 |
| `CLAIM_COUNT` | 引用数量 | **没有任何可观察证据** → `tool_unverified` |
| `CLAIM_HASH_REF` | 引用提交哈希 | **没有任何可观察证据** → `tool_unverified` |
| `CLAIM_FILE_EXISTS` | 引用文件 | 一次文件读取 |

最后一列背后有一条规则：**证据必须与它回答的主张对得上。**
`file-read` 能回答「引用某个文件／某一行」，因为读那个文件**就是**那个连接本身。
它**不能**回答「这件事已验证」—— 读了**某个**文件不等于验证了**那个**主张。
本插件早期版本把它当成能回答，结果是只要本次会话读过任何东西，
`git commit -m "verified on Windows"` 就会放行。

那四类映射到「无」不是遗漏。它们是这道门**能观察到、但无法裁决**的主张，
所以它如实说明并转人工（`tool_unverified`），而不是做出一个它支撑不起的指控。

一条都不命中 → 放行，理由是 `no-claim-in-action`。这些模式刻意是**语法层**的：
网撒得越大，对诚实工作的误拦越多，而一个爱喊狼来了的门最终会被关掉 ——
关掉之后它什么都不查了。

## 没查到证据时会怎样

| 情形 | 判定 | 理由 |
|---|---|---|
| 不是门管的动作 | `allow` | 没有要查的 |
| 门管的动作但没带主张 | `allow` | 仍然没有要查的 |
| 每条主张都有记录在案的证据 | `allow` | 主张与记录一致 |
| 有主张没证据，台账非空 | `review` | 主张没被支撑 |
| **台账是空的** | `review`，并说明原因 | 分不清「没发生」与「我没看见」 |
| 主张是任何可观察证据都答不了的 | `review`（`tool_unverified`） | 这是门的边界，不是指控 |
| 门自己抛了异常 | `review` | 缺陷不能变成静默放行 |

其中两行值得读两遍。

**空台账**的成因是门中途加载，或记录失败。在这种状态下报「测试没跑」
是一个自信的错误答案。门改为说出它**确实知道**的事 ——
而且空台账**既不能**产出放行，**也不能**产出一个基于事实的指控。

**`tool_unverified`** 是对这个插件永远查不了的主张的诚实回答。
提交信息写 `reverts abc1234` 是在引用一个哈希；台账观察不到任何能证实或推翻它的东西。
把它叫作「没被支撑」是这个门支撑不起的指控，所以它说出来然后转人工。

把 `decision` 设为 `deny` 可以直接拒绝而不询问。

## 配置

```yaml
- insert:
    - id: preclaim
      name: dsh-preclaim
      config:
        triggerTools: [pwsh, bash, write, edit, str_replace_editor]
        readmeGlobs: ['README*', 'CHANGELOG*', 'docs/**/*.md', '**/README.md']
        decision: review      # review | deny
        audit: true
        ledgerLimit: 500
        pushMessageLimit: 20
```

**刻意没有**任何一个能让「没被支撑的主张」通过的配置值。
`decision` 只在「询问」和「拒绝」之间选，别的什么都不行 ——
**带关闸的门一定会被关掉**。`resolveConfig` 对 `decision: allow` 直接抛错。

`pushMessageLimit` 限制一次 push 最多核对多少条提交信息，让开销不随仓库年龄增长。
上限生效时会在输出里说明，因为**被悄悄截断的检查读起来和完整的检查一样**。

## `evidence_status` 工具

```
evidence_status({ text: "fix: tests pass" })
```

报告台账状态、这段文本主张了什么、本次会话有没有证据、门会怎么判。
**在动手之前**调它，一次拦截的代价就从「被拒绝的动作」降到「改一句话」。

## 两处承重的解析细节

**先剥 ANSI 转义。** 即使是管道输出也可能带转义序列，于是一个选项可能以
`\u001b[1;33m--version\u001b[0m` 的形式到达。所有纯文本模式都会匹配不上，
门就会**悄悄停止识别它本来要检查的命令**。

**按不在引号内的操作符切段。** 只按 `;` 切会把 `git commit -m "a; b"` 切成两半，
活下来的那一半已经不像 commit 了 —— 信息里的主张就完全被漏掉。

两条都有测试钉死。

## 它不做什么

不读 transcript、不调模型、不评判工作做得好不好。
它只查一件很窄的事：**主张与本次会话对自身的记录是否一致。**

它也不持久化台账。证据是**本次会话**的属性，从磁盘恢复的台账是**另一次运行**的证据。

**它是安全带，不是沙箱。** 这里全部是文本匹配加台账。
`git commit -m "$(cat claim.txt)"`、模式不认识的测试命令、或者干脆不用 git，
都能绕过去。它拦的是常见情形 —— **自述比事实快了半步** ——
它不是防蓄意欺骗的机制。请不要把它说成后者。

## 刻意还没做的部分

设计里还规定了可选的第二层：当确定性层落在灰区时，问一次本地 150M Phocinae 模型，
服务不可达则 fail-closed。**这一层不在本版里。** 结果对象已经带着它会填的字段
（`model_verdict`、`model_calls`），而 `model_calls` 报 `0`，因为它是个真实计数器。

不做它的理由：确定性层才是实测价值的所在，而一个要加模型调用的层需要和别的东西
一样的证据标准 —— **一次测量，而不是一个假设**。把计数器发出去并如实报 `0`，
比发一个没人量过的层更诚实。

## 环境要求

Node `^22.19.0 || >=24.0.0`。零运行时依赖。`@deepseek-ai/cordis` 是可选 peer。

## 测试

```sh
npm test                  # 64 条测试，不需要主机
npm run verify:artifacts   # 检查 npm publish 真正会发出去的东西
```

覆盖 shell 解析（ANSI、引号、操作符、`-C`、只读动词、dry-run 抑制）、主张表、
台账的分种类成功规则、路径规范化之后的 glob 匹配、`next()` 调用纪律，
以及几条「绝不能放行」的路径：无法识别的判定值、门内部抛异常、载荷里没有工具名。

## 许可

Apache-2.0。
