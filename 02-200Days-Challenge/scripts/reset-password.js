'use strict';
/**
 * 本机账号维护工具（不需要登录，靠「能读写本机 data/ 目录」作为权限依据）。
 *
 *   node scripts/reset-password.js                    列出所有账号（不显示任何密码信息）
 *   node scripts/reset-password.js --reset 账号        从标准输入读取新密码并重置（密码不进命令行历史）
 *   node scripts/reset-password.js --reset 账号 新密码  直接以参数指定新密码
 *
 * 说明：密码以 scrypt 加盐哈希保存，不可逆，任何工具都「查不出」原密码，只能重置。
 * 重置会让该账号的登录会话全部失效，需要用新密码重新登录。
 */
const fs = require('fs');
const auth = require('../lib/auth');
const store = require('../lib/store');

const ROLE_LABEL = { student: '学生', teacher: '教师', admin: '管理员' };

function usage() {
  console.log([
    '用法:',
    '  node scripts/reset-password.js                      列出账号',
    '  node scripts/reset-password.js --reset <账号>        交互式重置（推荐，密码不留在命令历史）',
    '  node scripts/reset-password.js --reset <账号> <密码> 直接重置',
    '',
    '密码要求: 8–64 位，且同时包含字母和数字。',
  ].join('\n'));
}

function list() {
  const users = auth.listUsers();
  if (!users.length) {
    console.log('当前没有任何账号（系统尚未初始化，打开网站会进入「创建管理员账号」页面）。');
    return;
  }
  console.log('共 ' + users.length + ' 个账号，数据文件: ' + store.DATA_DIR + '/users.json');
  console.log('');
  console.log('账号'.padEnd(18) + '角色'.padEnd(8) + '显示名称'.padEnd(18) + '状态'.padEnd(8) + '创建时间');
  console.log('-'.repeat(84));
  for (const u of users) {
    console.log(
      String(u.username).padEnd(18) +
      String(ROLE_LABEL[u.role] || u.role).padEnd(8) +
      String(u.display_name || '').padEnd(18) +
      String(u.active ? '启用' : '停用').padEnd(8) +
      String(u.created_at || '').slice(0, 19).replace('T', ' ')
    );
  }
  console.log('');
  console.log('密码列不存在：系统只保存不可逆的 scrypt 哈希，任何页面、日志、文件都查不到明文密码。');
}

function readPasswordFromStdin() {
  process.stdout.write('请输入新密码（8–64 位，含字母与数字），输入后回车: ');
  let value = '';
  try {
    value = fs.readFileSync(0, 'utf8');
  } catch (_) {
    console.error('\n无法从标准输入读取密码。请改用参数形式，或用管理员后台「账号管理」重置。');
    process.exit(1);
  }
  return value.replace(/\r?\n$/, '');
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--list' || args[0] === '-l') return list();
  if (args[0] === '--help' || args[0] === '-h') return usage();

  if (args[0] === '--reset') {
    const username = args[1];
    if (!username) { usage(); process.exit(1); }
    const password = args[2] !== undefined ? args[2] : readPasswordFromStdin();
    const user = auth.findUser(username);
    if (!user) {
      console.error('账号不存在: ' + username);
      console.error('可先运行 node scripts/reset-password.js 查看全部账号。');
      process.exit(1);
    }
    try {
      auth.resetPassword(user.id, password);
    } catch (err) {
      console.error('重置失败: ' + err.message);
      process.exit(1);
    }
    console.log('已重置账号 ' + user.username + '（' + (ROLE_LABEL[user.role] || user.role) + '）的密码。');
    console.log('该账号原有登录会话已全部失效，请用新密码重新登录。');
    return;
  }

  usage();
  process.exit(1);
}

main();
