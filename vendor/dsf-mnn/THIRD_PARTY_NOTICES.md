# 第三方与算法来源

本项目初版独立实现机制，没有复制 HippoRAG、A-MEM 或 DSH 的实现源码。源码调查链接与固定 revision 见 docs/REFERENCE_RESEARCH.md。论文表达、图表与数据集未打包。

| 项目 | 许可 | 本项目用法 |
|---|---|---|
| HippoRAG 2.0.0a5 | MIT，Copyright (c) 2025 OSU Natural Language Processing | 阅读源码与论文；独立实现局部 PPR 与证据网络 |
| A-MEM agentic-memory 0.0.1 | MIT，Copyright (c) 2025 AGI Research | 机制参考；独立实现有界且可逆的 note 演化 |
| DeepSeek Harness 0.2.0-rc.2 | MIT，安装包声明及上游 LICENSE | 适配器可选 peer dependency；子类扩展公开接口，不重分发其包 |
| Python / SQLite | 各自官方许可 | 使用系统现有 runtime/标准库，不打包 runtime |
| sentence-transformers | Apache-2.0（可选依赖） | 未安装、未重分发；模型权重另有许可，启用前单独审查 |

以后若直接引入第三方代码或发布第三方依赖，必须保留对应完整许可证与版权声明。当前仓库自身代码许可待维护者决定；未擅自为维护者授予开源许可。

v1.1.0 的 CPU 计数可选使用 tokenizers（Apache-2.0）和 Jinja2（BSD-3-Clause），通过现有安装调用，不将第三方实现代码复制到源码分发。使用方应保留实际安装包许可证。

本次私有实验使用 [DeepSeek 官方词表下载](https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip)，ZIP SHA256 为 `e7310d1dafe0a86d8a5629fe78a7c763760f651db9b8682718a1781dcd6fe495`，tokenizer.json SHA256 为 `89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614`。只加载 JSON 和沙箱模板，未执行下载包中的 Python；不随公开源码包重分发词表。下载页未提供已确认的独立再分发许可，公开分发前需另核对。服务端计数依据 [官方 Token 用量说明](https://api-docs.deepseek.com/quick_start/token_usage/)，本地模板计数与实际封装用量分开记录。
