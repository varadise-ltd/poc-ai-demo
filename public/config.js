// 本地开发 / 无 nginx 部署的默认运行期配置：空对象 = 回退到 VITE_* 构建变量。
// nginx 镜像会用 location = /config.js 按环境变量覆盖本文件（见 nginx.conf.template）。
window.__POC_CONFIG__ = window.__POC_CONFIG__ || {}
