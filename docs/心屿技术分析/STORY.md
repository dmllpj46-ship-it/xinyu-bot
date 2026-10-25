# STORY.md — 心屿 · 心理陪练 Bot 技术分析

## ① 用户意图对齐

**目标受众**：技术评审 / 架构复盘场景下的工程师与架构师。他们不关心产品叙事，只关心三件事：为什么这么选、放弃了什么、代价落在哪里。

**核心目标**：讲完后希望他们相信三件事——
1. 这个项目的技术价值不在「用了 Agent SDK」，而在**发现模型会在最关键的时刻失效，并据此重写了架构**；
2. 每一个技术选型都能说清「放弃了什么」，没有一处是"顺手就用"；
3. 项目最大的结构性负债是**双运行时手写镜像**，这是已知风险，不是疏忽。

**PPT 长度**：10 页（封面 1 + 内容 8 + 结束 1）。Hero 页 3 个（30%），符合 10 页配额。

**视觉调性**：暖陶克制 · 结构清晰 · 编辑感 · 反"科技蓝" · 可信不炫技

**内容边界**：
- 必讲：模型拒答事件及其架构后果、四级危机分流、BM25 的取舍、Workers 迁移的 8 个适配点、双运行时负债
- 不讲：产品定位与用户价值（评审不关心）、UI 视觉细节、知识库内容来源
- 禁碰：任何诊断/药物表述；把"安全层"讲成合规摆设——它是架构的起因，不是附属品

---

## ② 页面布局骨架

**页面总数与分章**：10 页，**不设目录页与章节扉页**。
理由：10 页预算下，目录 + 4 个章节扉页会吃掉 5 页（50%），与"概览"目标冲突。改为靠每页标题自解释 + 页码建立导航感。因此目录声明的章节数 N = 0，全篇 `type: section` 页数 = 0，契约成立。

| 页 | 标题 | type | role | rhythm | layout | 对称? |
|---|---|---|---|---|---|---|
| 01 | 心屿 · 心理陪练 Bot | cover | hero | peak | 全幅图+骑线文字 | 非对称 |
| 02 | 三个约束，决定了全部选型 | content | supporting | valley | 左标题+右内容 | 非对称 |
| 03 | 一套业务，两个运行时 | content | supporting | transition | 上大图+下方卡片 | 非对称 |
| 04 | 危机路径调用模型 0 次 | content | hero | peak | 巨型数字+洞察 | 非对称 |
| 05 | 四级分流：宁可误报 | content | supporting | valley | 非对称双栏 | 非对称 |
| 06 | 10 篇文档，不值得上向量库 | content | supporting | peak | 图表+洞察 | 对称① |
| 07 | 迁移不是移植，是重写假设 | content | supporting | valley | 左标题+右内容 | 非对称 |
| 08 | 116 条测试，锁住的是红线 | content | supporting | transition | 非对称双栏 | 非对称 |
| 09 | 三笔技术债，第一笔是结构性的 | content | supporting | valley | 上大图+下方卡片 | 非对称 |
| 10 | 把不确定性挡在模型之外 | ending | hero | peak | 居中金句/巨型数字 | 对称② |

**Hero 页定位**：01（封面）、04（模型拒答 = 全篇论点核心）、10（收束）。间隔分别为 2 页、5 页，无相邻。

**rhythm 曲线**：peak(01) → valley(02) → transition(03) → peak(04) → valley(05) → peak(06) → valley(07) → transition(08) → valley(09) → peak(10)。无连续 3 页 valley。

**非对称版式预算**：8/10 = 80% ≥ 40% ✅
**对称版式预算**：仅 06、10 两页 ✅
**`N卡片横排`**：0 次 ✅
**`左大图+右侧文字` + `非对称双栏` 合计**：2 页（05、08）= 20% ≤ 40% ✅
**相邻页版式**：逐对检查均不同 ✅

---

## ③ 页面大纲

### 01 · 封面
- `title`: 心屿 · 心理陪练 Bot
- `type`: cover / `role`: hero / `rhythm`: peak / `layout`: 全幅图+骑线文字
- `visual`: L1: 全幅 SVG 结构底图（右侧 62%，同心弧线 + 节点，抽象"分级"意象）
- `visual_role`: atmosphere
- `density`: 字数约 45 / 图片 1（SVG 底图）/ 留白约 42%
- `anti_pattern`: 禁止标题居中对称；禁止在标题块右侧塞装饰小图；禁止把「技术分析」写成大标语挤掉主标层级
- `description`: 主标「心屿」+ 副标「一个会主动闭嘴的心理陪练 Bot · 技术分析」。辅助信息：10 页 / 技术评审 / 2026-10。判断：封面要让人一眼知道这不是产品介绍，是架构复盘——所以副标直接抛出最反直觉的设计决定。

### 02 · 三个约束
- `title`: 三个约束，决定了全部选型
- `type`: content / `role`: supporting / `rhythm`: valley / `layout`: 左标题+右内容
- `visual`: L1: 左侧竖向色块标题栏（占 32%）；右侧三条约束各带一个数字标记
- `visual_role`: anchor
- `density`: 字数约 240 / 图 0 / 留白约 22%
- `anti_pattern`: 禁止三条等宽卡片横排；禁止把约束写成"优点清单"（要写它排除了什么）
- `description`: 三条硬约束：①不引框架与构建 → 排除 React/Tailwind；②离线可用 → 排除一切 CDN；③一个人能读懂 → 排除 LangChain 与向量库。判断：约束不是限制而是设计工具——它把「选什么」变成了「什么不能选」，选型空间被压到只剩一条路。

### 03 · 双运行时
- `title`: 一套业务，两个运行时
- `type`: content / `role`: supporting / `rhythm`: transition / `layout`: 上大图+下方卡片
- `visual`: L1: 上半部架构 SVG（占 B 区 56%）——浏览器 → 两个入口（FastAPI / Worker）→ Agent SDK → Mercury 3 → 三个工具
- `visual_role`: anchor
- `density`: 字数约 200 / 图 1 / 留白约 20%
- `anti_pattern`: 禁止把架构图画成 8 个等宽方块；禁止下方卡片做成四列等宽
- `description`: 开发走 FastAPI + Python SDK 0.24，生产走 Workers + TS SDK 0.21；`web/` 共用，`safety/` 与 `tools/` 手写镜像。判断：为了「能部署到 Workers」付出了两套实现的代价——这是本项目最大的结构性负债，第 9 页会正面处理。

### 04 · 关键发现（Hero）
- `title`: 危机路径调用模型 0 次
- `type`: content / `role`: hero / `rhythm`: peak / `layout`: 巨型数字+洞察
- `visual`: L1: 巨型数字「0」（144px）+ 右侧引文块（API 原始拒答英文）
- `visual_role`: anchor
- `density`: 字数约 190 / 图 0 / 留白约 40%
- `anti_pattern`: 禁止把「0」缩进卡片角落；禁止用图标替代数字；禁止只写结论不贴原始报错
- `description`: Mercury 3 的 API 层会拒答自杀相关内容——实测用户说「我真的不想活了，已经想好怎么做了」，返回 `potentially dangerous or harmful content`。判断：最需要它说话的时刻，模型会闭嘴。于是 L2/L3 完全不调模型，走写死话术，号码从常量表取。代价是失去个性化；危机当下，稳定 > 贴切。

### 05 · 四级分流
- `title`: 四级分流：宁可误报
- `type`: content / `role`: supporting / `rhythm`: valley / `layout`: 非对称双栏（62:38）
- `visual`: L1: 左栏四级阶梯（L0–L3 高度递增的色块）；右栏四个"已处理的规避手法"
- `visual_role`: anchor
- `density`: 字数约 300 / 图 1 / 留白约 18%
- `anti_pattern`: 禁止四级做成等高等宽卡片；禁止只列级别不写触发示例
- `description`: L0 日常压力 / L1 被动意念（不给卡片但直问）/ L2 主动意念（卡片 + 写死话术）/ L3 即时危险（先 120 再 12356）。已处理四类规避：否定式「我不会自杀」、否定不赦免后半句、第三人称「我朋友想自杀」、空格规避「自 杀」。判断：误报代价只是多问一句，漏报不可逆——所以分级只做加严不做放宽。

### 06 · 检索
- `title`: 10 篇文档，不值得上向量库
- `type`: content / `role`: supporting / `rhythm`: peak / `layout`: 图表+洞察
- `visual`: L1: 横向条形图（BM25 分数分布，展示加门槛前后的差异）+ 右侧参数标注
- `visual_role`: evidence
- `density`: 字数约 160 / 图 1 / 留白约 25%
- `anti_pattern`: 禁止把参数写成无解释的清单；禁止用饼图
- `description`: 72 块，K1=1.5 / B=0.75；CJK 二元分词 + 单字降权 0.35 + 停用字；覆盖度门槛 0.34。判断：纯 BM25 会让「量子色动力学」命中「行为动力」——问题不在排序，在召回。10 篇文档的规模，向量库是纯负债。

### 07 · 迁移
- `title`: 迁移不是移植，是重写假设
- `type`: content / `role`: supporting / `rhythm`: valley / `layout`: 左标题+右内容
- `visual`: L1: 左侧窄色块标题栏；右侧 8 行对照（原实现 → Worker 做法），行间用细线分隔
- `visual_role`: anchor
- `density`: 字数约 260 / 图 0 / 留白约 15%
- `anti_pattern`: 禁止做成两列等宽表格铺满；禁止省略"为什么不行"那一列
- `description`: 8 个适配点：SQLiteSession→浏览器 history、读盘 JSON→构建期编译 TS、ChatCompletions 适配、extra_body→providerData、function_tool→tool()、httpx→fetch、StreamingResponse→ReadableStream、静态挂载→assets+run_worker_first。判断：Workers 不是"把 Python 跑起来"，是把每一个运行时假设（有文件系统、有持久进程、有中间件）全部重写一遍。

### 08 · 验证
- `title`: 116 条测试，锁住的是红线
- `type`: content / `role`: supporting / `rhythm`: transition / `layout`: 非对称双栏（58:42）
- `visual`: L1: 左栏测试分层（Python 60 / TS 56，按模块拆）；右栏三条"非直觉测试"
- `visual_role`: anchor
- `density`: 字数约 250 / 图 0 / 留白约 20%
- `anti_pattern`: 禁止只报总数不报分布；禁止把测试数量当成绩单（要写它防住了什么）
- `description`: Python 60 例 + TypeScript 56 例，同一批用例两端跑。三条非直觉的测试：①prompt 与知识库不得出现 5 位以上数字（防模型凭记忆编号码）②热线常量必须在输出护栏白名单内（否则会被自己替换掉）③L2 路径断言 `scripted:true` 且工具列表为空。判断：安全逻辑的正确性不能靠人眼 review，必须靠测试锁住——红线一旦回归就是事故。

### 09 · 技术债
- `title`: 三笔技术债，第一笔是结构性的
- `type`: content / `role`: supporting / `rhythm`: valley / `layout`: 上大图+下方卡片
- `visual`: L1: 上半部债务权重 SVG（三条水平条，长度差异明显，第一条最长）+ 下方三张不等宽卡片
- `visual_role`: anchor
- `density`: 字数约 230 / 图 1 / 留白约 18%
- `anti_pattern`: 禁止三张等宽卡片横排；禁止把结构性负债和可接受取舍写成同一语气
- `description`: ①双运行时手写镜像（结构性：改 safety 必须改两处，靠测试对齐行为）②无状态失忆（刷新即丢，历史由浏览器持有）③块式流式（靠前端 12ms/字补间抹平）。判断：第一笔是结构性的、会随时间恶化；后两笔是主动取舍，代价可量化，可以接受。

### 10 · 结束（Hero）
- `title`: 把不确定性挡在模型之外
- `type`: ending / `role`: hero / `rhythm`: peak / `layout`: 居中金句/巨型数字
- `visual`: L1: 居中大字 + 下方三个数字（0 / 116 / 72）
- `visual_role`: anchor
- `density`: 字数约 60 / 图 0 / 留白约 48%
- `anti_pattern`: 禁止写"谢谢观看"；禁止堆四行以上总结；禁止用渐变大字
- `description`: 一句话收束：这个项目真正的方法论是「凡是不能出错的判断，都不要交给模型」。三个数字佐证：危机路径调用模型 0 次 / 116 条测试 / 72 个知识库块。判断：把不确定性挡在模型之外，是这个项目唯一称得上"架构"的东西。
