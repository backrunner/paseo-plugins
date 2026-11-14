import { defineTranslations, useTranslation } from '@getpaseo/plugin/client';

export const messages = defineTranslations({
  resources: {
    en: {
      queue: 'Evo queue',
      send: 'Queue a message',
      goal: 'Manage a goal',
      retry: 'Manage retries',
      later: 'Send later',
      pending: 'Queue · {{count}}',
      automation: 'Continuation settings',
    },
    'zh-CN': {
      queue: 'Evo 队列',
      send: '将消息加入队列',
      goal: '管理目标',
      retry: '管理重试',
      later: '稍后发送',
      pending: '队列 · {{count}}',
      automation: '续跑设置',
    },
  },
});
export function useCopy() {
  const { locale } = useTranslation(messages);
  return (zh: string, en: string) => (locale.startsWith('zh') ? zh : en);
}
export const reasons: Record<string, [string, string]> = {
  queued: ['排队中', 'Queued'],
  approval: ['等待允许发送', 'Waiting for delivery approval'],
  'user-paused': [
    '已暂停发送，正在运行的回合不受影响',
    'Delivery paused; the current turn is unchanged',
  ],
  paused: ['已暂停', 'Paused'],
  busy: ['等待会话空闲', 'Waiting for idle'],
  permission: ['等待权限处理，自动发送已暂停', 'Permission pending; automation paused'],
  time: ['等待发送时间', 'Waiting for time'],
  'idle-check': ['确认会话空闲', 'Checking idle state'],
  'quota-unknown': ['额度信息不足，继续等待', 'Quota unavailable; waiting'],
  'quota-exhausted': ['等待额度恢复', 'Waiting for quota recovery'],
  'quota-poll-wait': ['等待额度查询', 'Waiting for a quota check'],
  'quota-awaiting-exhaustion': [
    '等待下一次额度耗尽及恢复',
    'Waiting for the next exhaustion and recovery',
  ],
  'quota-account-changed': [
    '额度账户变化，请检查后重新设置',
    'Quota account changed; review settings',
  ],
  'session-changed': [
    '会话有新输入或 provider 变化，请检查后恢复',
    'New input or provider change; review before resuming',
  ],
  'outcome-unknown': [
    '发送结果不明确，已停止重发，请检查会话',
    'Delivery outcome unknown; inspect the conversation',
  ],
  'receipt-found': ['已确认消息到达', 'Message receipt found'],
  'receipt-found-review': ['已确认消息到达，请检查后恢复', 'Receipt found; review before resuming'],
  'turn-canceled': ['回合已取消，自动发送暂停', 'Turn canceled; automation paused'],
  'retry-budget': ['已达到重试上限', 'Retry limit reached'],
  'error-auth': ['需要处理登录或权限错误', 'Authentication needs attention'],
  'error-context': ['需要处理上下文长度错误', 'Context limit needs attention'],
  'error-unknown': ['错误无法安全分类，已暂停', 'Unrecognized error; paused'],
  'error-quota': ['额度耗尽，自动恢复未启用', 'Quota exhausted; recovery disabled'],
  'queue-already-pending': ['已有排队消息，没有追加续跑', 'A queued message already exists'],
  'goal-report-missing': [
    '未获得有效进展报告，请检查目标',
    'No valid progress report; review the goal',
  ],
  'goal-needs-review': ['目标需要人工处理', 'Goal needs attention'],
  'goal-queue-conflict': [
    '先处理已有队列，再恢复目标',
    'Resolve queued messages before resuming the goal',
  ],
  'delivery-review': [
    '发送后状态无法核实，请检查会话',
    'Post-delivery state unavailable; review the conversation',
  ],
  archived: ['会话已归档', 'Session archived'],
  'session-closed': ['会话已关闭', 'Session closed'],
  sending: ['正在发送', 'Sending'],
  sent: ['已发送', 'Sent'],
  canceled: ['已取消', 'Canceled'],
  withdrawn: ['已撤回', 'Withdrawn'],
  expired: ['已过期', 'Expired'],
};
