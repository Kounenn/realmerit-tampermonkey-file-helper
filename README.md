# 睿美云一键补报助手（Tampermonkey）

> 一个 Tampermonkey 用户脚本，自动为「睿美云」医疗管理系统中的**过期未报备客户**批量补报目标客户，省去逐个手动填写的重复劳动。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-UserScript-blue.svg)](https://www.tampermonkey.net/)
![Version](https://img.shields.io/badge/version-3.4-green.svg)

---

## 背景

在医美/医疗门店的客管系统「睿美云」中，客户的目标报备有有效期（例如报备后 7 天到期）。过期后需要重新补报，流程繁琐：筛选过期客户 → 逐个打开档案 → 切到报备记录 → 下载历史截图 → 打开报备表单 → 填手机号 → 勾选科室 → 上传截图 → 保存。

当待补报客户有几十条甚至上百条时，纯手工操作极其耗时。本脚本在浏览器端自动完成上述全流程，支持**批量勾选、一键补报**。

## 功能特性

- ✅ **批量补报**：在客户列表勾选多名客户，点一次按钮即可自动依次处理
- ✅ **自动填表**：填手机号后自动触发系统联动填充（客户姓名/来源/报备人/部门）
- ✅ **科室勾选**：自动勾选「皮肤科」「注射科」等目标科室
- ✅ **历史截图复用**：自动从报备记录中下载历史截图作为附件上传
- ✅ **智能注入**：列表每行客户姓名前自动注入勾选框，翻页/抽屉/弹窗内不误注入
- ✅ **状态反馈**：实时进度面板 + 完成通知，结果统计（成功/失败/跳过）
- ✅ **不跳转**：处理完不刷新、不跳页，停留在当前列表

## 环境要求

- 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（或兼容的脚本管理器）
- 可正常登录 `https://system.realmerit.com.cn/` 的账号
- 脚本以「顶层模式」运行，通过 `contentDocument` 穿透 SolidJS 外壳操作内部 iframe 的 React/Ant Design DOM

## 安装

1. 安装 Tampermonkey 扩展。
2. 新建脚本，将 [`tampermonkey-file-helper.js`](tampermonkey-file-helper.js) 的全部内容粘贴进去并保存。
   - 也可以直接把该文件拖入 Tampermonkey 管理页完成导入。
3. 进入睿美云客户列表页，右上角会出现「睿美云补报助手」控制面板。

> 作者：`@kounenn`

## 使用步骤

1. 在客户列表筛选「过期」客户。
2. 在每条客户姓名前勾选要补报的客户（或用表头全选）。
3. 点击控制面板的 **「批量补报选中客户」**。
4. 在弹出的总确认框点「确定」，**后续自动批量处理，无需再逐个确认**。
5. 处理完成后查看面板统计与系统通知。

## 工作原理（技术要点）

- **iframe 穿透**：睿美云是 SolidJS 外壳 + 同源 iframe（React + Ant Design）。脚本在顶层运行，通过 `iframe.contentDocument` 直接操作内部 DOM。
- **React 受控组件赋值**：输入框用 `Object.getOwnPropertyDescriptor` 取值器 + `dispatchEvent` 写入，并派发 `focusout` 事件触发系统联动填充（规避 `blur()` 导致焦点跳到只读字段的问题）。
- **TreeSelect 科室勾选**：按 form-item label 精确定位 `.ant-select-tree-checkbox` 后逐项勾选。
- **附件下载**：从报备记录表格的行内附件图标触发图片查看器，下载历史截图作为新报备附件。

## 文件说明

| 文件 | 说明 |
|------|------|
| `tampermonkey-file-helper.js` | 脚本本体（唯一需要发布的源码） |
| `README.md` | 本说明 |
| `LICENSE` | MIT 许可证 |

> 仓库已通过 `.gitignore` 排除所有客户数据（`.csv`）、截图（`.png`）与调试脚本，请勿将含隐私的文件提交到公开仓库。

## 隐私与安全

- 本仓库**不包含任何真实客户数据**，所有 CSV/PNG 均为本地调试产物，已被 `.gitignore` 忽略。
- 脚本仅在你自己的浏览器本地运行，不会向任何第三方服务器发送数据。
- 请勿将包含客户个人信息的文件提交到公开仓库，以免违反个人信息保护相关法规。

## 免责声明

- 本项目与「睿美云 / 睿美科技」及其关联方**无任何隶属或合作关系**，仅为个人效率工具。
- 脚本按「现状」提供，作者不对使用后果（包括但不限于数据填写错误、账号异常）承担责任。
- 请仅在拥有合法权限的账号与数据上使用，遵守所在机构的管理规定与平台服务条款。
- 自动化操作可能受目标系统改版影响而失效，需自行维护选择器。

## 许可证

[MIT License](LICENSE) © 2026 作者保留权利。

## 贡献

欢迎提交 Issue 与 Pull Request。涉及选择器适配、新科室、流程优化的改动请附上复现说明。
