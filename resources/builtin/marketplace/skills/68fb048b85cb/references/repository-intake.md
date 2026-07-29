# 仓库勘察与紧凑地图

用于任何非一次性代码变更的第一步。目标不是读完整个仓库，而是在有限上下文内找出支配规则、相关结构和可运行验证入口。

## 1. 确认作用域与状态

1. 确认工作目录和目标路径，不把 home、文件系统根目录或模糊 glob 当成修改目标。
2. 读取 Git 状态、当前分支和目标文件状态。把已有修改视为用户工作；不 reset、checkout、覆盖或顺手整理。
3. 查找根目录及目标路径向上的 `AGENTS.md`、`AGENT.md`、`CLAUDE.md`、`README*`、`CONTRIBUTING*`。
4. 规则优先级：用户当前明确指令 > 最近作用域的仓库规则 > 上层仓库规则 > 本 skill 默认值。发现冲突时记录最终采用的规则。
5. 不读取 `.env*`、凭据目录、私钥或 secret store 的值，除非用户明确要求某个必要文件；任何输出都不得回显秘密。

## 2. 找出工程入口

只读取与当前任务有关的入口：

- 语言、框架、manifest、lockfile 和现有依赖。
- build、typecheck、lint、test、dev、format 命令及 CI 中的真实调用方式。
- 测试目录、fixture、mocks、迁移工具和生成代码约定。
- 最近的同类模块、同类测试和同类错误处理方式。

命令来自仓库证据，不凭习惯猜测。缺失的依赖不视为已安装。

## 3. 建立符号级地图

围绕目标行为记录一个紧凑地图：

```text
入口 / 触发点
  -> 关键符号或组件
      -> 直接调用者 / 引用
      -> 数据、接口或状态边界
      -> 对应测试 / fixture
      -> 受影响的输出或用户界面
```

- 先搜索符号、引用、导入和调用路径，再打开文件。
- 优先读取关键定义和直接调用者；长文件只读相关切片。
- 对重构，先找全部引用、实现和序列化边界。
- 对 bug，标出输入进入点、第一个错误状态和一个正常对照路径。
- 对 feature，标出行为入口、状态变化、持久化/API 边界和验证表面。

## 4. 输出工程合同

```markdown
## Repository Contract
- Task type:
- Governing instructions:
- Existing worktree changes to preserve:
- Relevant modules / symbols / call paths:
- Existing patterns to mirror:
- Baseline / reproduction command:
- Focused verification command:
- Open material decision:
```

只有无法从仓库或已有材料判断、且答案会实质改变实现时，才向用户提出阻塞问题。
