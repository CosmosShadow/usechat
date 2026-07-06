# Helper Runtime 打包

这里会放 helper runtime 的打包、manifest、安装、升级和 release 脚本。

普通用户应通过显式命令安装 helper runtime：

```bash
usechat setup-helper
```

不得在 npm postinstall 阶段静默安装 helper runtime。
