import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import containerPlugin from 'markdown-it-container'

export default withMermaid(
  defineConfig({
    title: '从系统工具到操作系统',
    description: '用 Zig 写真实项目，在做的过程中学操作系统',
    lang: 'zh-CN',
    base: '/hands-on-os/',

    markdown: {
      config: (md) => {
        md.use(containerPlugin, 'expand', {
          render(tokens, idx) {
            const token = tokens[idx]
            if (token.nesting === 1) {
              const title = token.info.trim().slice('expand'.length).trim() || '拓展'
              return `<div class="expand custom-block"><p class="custom-block-title">${title}</p>\n`
            }
            return '</div>\n'
          }
        })
        md.use(containerPlugin, 'thinking', {
          render(tokens, idx) {
            const token = tokens[idx]
            if (token.nesting === 1) {
              const title = token.info.trim().slice('thinking'.length).trim() || '一起思考 🤔'
              return `<div class="thinking custom-block"><p class="custom-block-title">${title}</p>\n`
            }
            return '</div>\n'
          }
        })
      }
    },

    themeConfig: {
      nav: [
        { text: '首页', link: '/' },
        { text: '前言', link: '/prologue' },
        { text: '开始学习', link: '/basics/01-os-overview' },
      ],

      sidebar: [
        {
          text: '前言',
          link: '/prologue',
        },
        {
          text: '基础与概览',
          items: [
            { text: '操作系统全景', link: '/basics/01-os-overview' },
            { text: '系统调用与双模式', link: '/basics/02-syscall-dual-mode' },
          ],
        },
        {
          text: '进程管理',
          items: [
            { text: '进程生命周期', link: '/process/01-lifecycle' },
            { text: '信号', link: '/process/02-signal' },
            { text: '进程组与会话', link: '/process/03-process-group' },
            { text: 'CPU 调度', link: '/process/04-scheduling' },
            { text: 'Linux 调度器', link: '/process/05-linux-scheduler' },
            { text: '命名空间', link: '/process/06-namespace' },
            { text: 'Cgroups', link: '/process/07-cgroup' },
          ],
        },
        {
          text: '线程与并发',
          items: [
            { text: '线程', link: '/concurrency/01-thread' },
            { text: '同步原语', link: '/concurrency/02-synchronization' },
            { text: '死锁', link: '/concurrency/03-deadlock' },
            { text: '事件驱动并发', link: '/concurrency/04-event-driven' },
            { text: '内核同步机制', link: '/concurrency/05-kernel-synchronization' },
          ],
        },
        {
          text: '内存管理',
          items: [
            { text: '地址空间与分页', link: '/memory/01-address-space-paging' },
            { text: '虚拟内存', link: '/memory/02-virtual-memory' },
            { text: '内存映射', link: '/memory/03-memory-mapping' },
            { text: '内核内存分配', link: '/memory/04-kernel-memory' },
          ],
        },
        {
          text: '网络与 IPC',
          items: [
            { text: 'Socket 与 TCP', link: '/network/01-socket-tcp' },
            { text: 'IPC 机制', link: '/network/02-ipc' },
            { text: '高性能网络', link: '/network/03-high-performance-network' },
          ],
        },
        {
          text: '存储与 I/O',
          items: [
            { text: 'I/O 系统', link: '/storage/01-io-system' },
            { text: '中断与设备驱动', link: '/storage/02-interrupt-driver' },
            { text: '块层', link: '/storage/03-block-layer' },
          ],
        },
        {
          text: '文件系统',
          items: [
            { text: '文件与目录', link: '/filesystem/01-file-directory' },
            { text: 'VFS 与实现', link: '/filesystem/02-vfs' },
            { text: '日志与一致性', link: '/filesystem/03-journal-consistency' },
            { text: '崩溃一致性实践', link: '/filesystem/04-crash-consistency' },
          ],
        },
        {
          text: '保护与安全',
          items: [
            { text: '保护与安全', link: '/security/01-protection-security' },
          ],
        },
        {
          text: '虚拟化',
          items: [
            { text: '虚拟化', link: '/virtualization/01-virtualization' },
          ],
        },
        {
          text: '从裸机到操作系统',
          items: [
            { text: '引导与内存', link: '/bare-metal/01-boot-memory' },
            { text: '中断与进程', link: '/bare-metal/02-interrupt-process' },
            { text: '系统调用与文件系统', link: '/bare-metal/03-syscall-filesystem' },
            { text: '设备与网络', link: '/bare-metal/04-device-network' },
          ],
        },
        {
          text: '可观测性',
          items: [
            { text: '性能分析与内核追踪', link: '/observability/01-perf-tracing' },
          ],
        },
      ],

      search: {
        provider: 'local',
      },

      outline: {
        level: [2, 3],
        label: '目录',
      },

      docFooter: {
        prev: '上一篇',
        next: '下一篇',
      },
    },
  })
)
