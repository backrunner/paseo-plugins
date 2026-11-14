# Paseo plugins

面向 **Paseo 0.15.4** 的社区插件 monorepo，与 Paseo 官方项目无隶属关系。

| 插件 | 版本 | 用途 | 说明 |
| --- | --- | --- | --- |
| SubscriptionEvo | 0.1.5 | 定时消息、额度恢复续跑与目标循环 | [使用与验证](docs/subscription-evo-implementation.md) |
| Session Reference | 0.1.1 | 引用已有会话，按需读取和搜索历史 | [使用与安装](docs/session-reference.md) |
| Media Preview | 0.1.0 | 在工作区文件标签页预览音频和视频 | [使用与安装](plugins/media-preview/README.md) |

当前版本仍处于开发阶段；各插件的实际验收范围和限制见对应说明。

SubscriptionEvo 提供定时消息、额度恢复后延迟发送、临时错误续跑和跨 provider 的目标循环。输入区的“稍后发送”展开原生浮层；“队列 · N”只在有待处理消息时出现。浮层只负责消息和发送时间。续跑在插件设置中按会话配置，目标通过 `/evo-goal` 打开。

SubscriptionEvo 的自动检查、安装和重载验证见实施记录；真实发送和新版宿主内界面仍待人工验收。

## 本地开发

**Session Reference（会话引用）**：在新输入框的附件菜单中选择“引用会话”，再输入接续要求。附件只携带来源和截止位置，agent 通过插件工具按需读取概览、搜索和分页历史。操作方式和验证边界见 [会话引用说明](docs/session-reference.md)。

当前开发检查使用 Node 26.12.1 和仓库指定的 pnpm 12.3.4：

```sh
pnpm install --frozen-lockfile
pnpm verify:evo
```

`verify:evo` 只检查 SubscriptionEvo，运行类型检查、模拟调度器、适配器、存储、界面及安装命令测试。测试使用临时目录和模拟客户端，不连接 Paseo，不调用模型。`pnpm verify` 可用于全 monorepo 检查。

## 安装和更新开发版

以下操作留给人工执行。将 `/absolute/path/to/paseo-home` 替换为你选定的 daemon home；可以先选择独立开发实例。命令没有默认目标，也不读取 `PASEO_HOST` 来决定目标。

先预览，不读取目标配置、不连接 daemon：

```sh
pnpm plugin:install --home /absolute/path/to/paseo-home --dry-run
pnpm plugin:update --home /absolute/path/to/paseo-home --dry-run
```

正式安装、修改源码后更新：

```sh
pnpm plugin:install --home /absolute/path/to/paseo-home
pnpm plugin:update --home /absolute/path/to/paseo-home
```

目标 daemon 需要已经运行，且已由你开启插件总开关。命令会先运行 `verify:evo`，确认同名插件来自本仓库，再安装本地目录或只重载 `subscription-evo`。成功后检查插件状态是否为 `running`。不会启用插件总开关、启动或重启 daemon，也不会替换其他目录的同名插件。宿主按 manifest 限制兼容版本为 0.15.4。

开发版直接引用 `plugins/subscription-evo`，不需要 npm 发布。源码改动需要运行更新命令；单纯改文件不会自动重载。

安装后，在目标会话打开“稍后发送”，填写该主机的 Paseo home 并连接。插件会核对 daemon 身份。自动发送、临时错误重试、额度恢复续跑均默认关闭，默认没有目标。已绑定的主机无需再次连接。Codex 自动模式需要确认原生 `/goal` 已关闭。

续跑设置位于 **设置 → 插件 → SubscriptionEvo → 续跑设置**。先明确选择会话，再修改并保存；不会对其他会话生效。`/evo-retry` 可打开同一设置页并选中当前会话。目标只通过 `/evo-goal [目标描述]` 打开，打开表单本身不会创建目标或发送消息。

## 输入与队列

1. 点击输入区的“稍后发送”，在浮层中填写消息。
2. 选择空闲、指定时间或额度恢复后发送。指定时间使用设备本地时间，提供 10、30、60 分钟快捷项；额度恢复可设置固定或随机延迟。
3. 点击“安排发送”只授权这一条消息按条件投递；“仅排队”保留消息等待后续授权。两者都不会启用自动续跑。
4. “队列 · N”显示待发送、发送中及结果待确认的消息；已发送、取消和过期历史不占入口。关闭浮层会保留本客户端未提交的正文；未确认提交保留相同请求 ID，重试不会重复入队。客户端退出或插件重载会清除这些未提交草稿。
5. 待发送消息可直接“编辑”或“撤回”。编辑先暂停原消息，正文和发送条件可一起修改，保存后仍在原队列位置；选择“保存并暂停”或“保存并安排”。关闭或放弃编辑不会恢复发送。撤回后原文留在历史中，可复制；发送中和结果不明的消息不能撤回。
6. 每条消息的“更多操作”提供查看全文、复制、暂停或允许按条件发送、上移。历史入口仅在有历史记录时显示。已创建任务持久化在主机端，正常重载保留队列顺序、发送条件和单条授权；在途结果不明时停下来等待检查，不重复发送。

Paseo 0.15.4 只向插件开放输入框上方的按钮轨道，未开放输入框下方的工具栏插槽，也不能读取原生草稿或替换原生发送行为。因此当前入口仍位于上方，消息在浮层里填写；它不会把原生输入框中的内容自动取走。队列消息和随后普通输入均发送给原来的 `agentId`，不会创建新会话。

原有面板保留为 Command Center 与 slash 命令的备用入口：

```text
/evo-send idle -- 检查刚才的修改并运行测试
/evo-send at 2026-11-16T09:30+08:00 -- 继续处理剩余问题
/evo-send after-quota 2-5m -- continue
/evo-queue
/evo-retry
/evo-goal 修复问题，并以测试通过作为完成条件
```

- `evo-send` 入队；指定时间必须是未来时间并包含时区。
- `evo-queue` 打开队列；`evo-retry` 打开续跑设置；`evo-goal` 打开目标表单并预填描述。暂停、恢复与清除目标在面板中完成。
- 消息可编辑、暂停、上移或撤回。严格按当前会话的 Evo 队列顺序发送，前一条未就绪时后面的继续等待。
- 额度延迟从首次获得可信恢复报告开始计时；最小值与最大值相同就是固定延迟。随机延迟只抽样一次并持久化。
- 普通输入视为手动接管，会暂停自动续跑。要继续托管新任务，可以从 Evo 队列提交，或在面板检查后恢复。

**携带附件时不要使用 `/evo-*`。** Paseo 0.15.4 会跳过插件 slash handler，可能把命令原文发送给模型。请移除附件或使用“稍后发送”浮层；当前插件队列只支持浮层中的文本，不会带走原生输入框的附件。

Evo 是独立扩展队列。0.15.4 没有公开的原生队列控制接口，因此不能与原生 queued rows 合并，也不能保证两套队列的全局先后顺序。

## 当前边界

自动发送需要多次空闲检查，但 Paseo 0.15.4 缺少原子的“仅空闲时发送”接口，仍存在其他客户端恰好同时发送的竞争。默认仅排队适合仍在人工交互的会话。

重试和目标循环不限制 provider 名称。额度恢复还要求宿主能为该会话返回唯一、足够新鲜的额度报告，且所有窗口均有剩余额度；未知或多账户不明确时等待。预计重置时间不作为恢复证明。不要在托管期间切换订阅登录。

发送回执丢失或崩溃后的结果不明确时，消息停在“需要检查”，不会盲目重发。目标完成来自模型的带证据报告，不等同于独立验证。缺少有效报告、连续没有进展、超出回合或时间预算时停止。

详细实现、容量限制和人工验收步骤见 [实施与验证记录](docs/subscription-evo-implementation.md)。原始接口研究见 [可行性研究](docs/subscription-evo-research.md)。

如已另行取得 Paseo v0.15.4 源码，可运行其编译器做离线兼容检查：

```sh
pnpm plugin:check-compiler --source /absolute/path/to/paseo-v0.15.4
```

此命令只读源码并编译插件，不启动或连接 Paseo。

## 获取源码

```sh
git clone https://github.com/backrunner/paseo-plugins.git
cd paseo-plugins
pnpm install --frozen-lockfile
pnpm verify
```

按各插件说明从本地目录安装到你选定的 daemon。包中的 `private: true` 用于防止误发到 npm，源码按下方许可证开源。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)，版权声明见 [NOTICE](NOTICE)。第三方依赖保留各自的许可证。
