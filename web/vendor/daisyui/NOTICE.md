# 第三方资源与许可

## daisyUI 5.7.50

- 项目：https://daisyui.com
- 仓库：https://github.com/saadeghi/daisyui
- 许可：MIT License，Copyright (c) Pouya Saadeghi
- 本仓库用法：只取用其中 10 个组件的**预编译 CSS**，拼接为
  `web/vendor/daisyui/daisyui-subset.css`，**不引入 Tailwind 运行时、不引入构建流程**。
- 取用清单：`theme/caramellatte.css`、`components/{chat,button,textarea,input,alert,loading,avatar,badge,collapse,divider}.css`
- 主题变量已在本项目 `web/preview.css` 第 1 节整体覆盖为暖陶色，未修改 daisyUI 原始文件。

复现命令：

```bash
base=https://cdn.jsdelivr.net/npm/daisyui@5
{ curl -sL "$base/theme/caramellatte.css";
  for c in chat button textarea input alert loading avatar badge collapse divider; do
    echo; curl -sL "$base/components/$c.css"; done; } \
  > web/vendor/daisyui/daisyui-subset.css
```

MIT 允许修改与再分发，但要求保留版权与许可声明——上面这段即是声明，请勿删除本文件。
