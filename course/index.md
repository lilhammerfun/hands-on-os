---
layout: home

hero:
  name: 动手学操作系统
  text: 从内核源码到系统实现
  tagline: 对照 Linux 内核源码学原理，用 Zig 从零构建四个真实系统
  actions:
    - theme: brand
      text: 开始阅读
      link: /prologue
    - theme: alt
      text: 基础与概览
      link: /basics/01-os-overview
---

<div class="projects-section">
  <p class="projects-lead">四个项目，从用户态到裸机</p>
  <div class="projects-grid">
    <a class="project-card" href="/zish/01-repl">
      <code class="project-name">zish</code>
      <span class="project-label">Shell</span>
      <span class="project-desc">进程 · 信号 · 管道 · 作业控制</span>
    </a>
    <a class="project-card" href="/zedis/01-event-loop">
      <code class="project-name">zedis</code>
      <span class="project-label">内存数据库</span>
      <span class="project-desc">事件循环 · fork-COW · 持久化 · 多线程</span>
    </a>
    <a class="project-card" href="/zcryptfs/01-fuse-memfs">
      <code class="project-name">zcryptfs</code>
      <span class="project-label">加密文件系统</span>
      <span class="project-desc">FUSE · 透明加密 · 日志 · 崩溃一致性</span>
    </a>
    <a class="project-card" href="/zigos/01-boot-memory">
      <code class="project-name">zigos</code>
      <span class="project-label">裸机操作系统</span>
      <span class="project-desc">引导 · 页表 · 中断 · 系统调用 · 设备</span>
    </a>
  </div>
</div>
