import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SERVICE_LABEL, formatServiceStatus, servicePlist } from '../src/service.js';

describe('launchd service plist', () => {
  it('servicePlist 生成 LaunchAgent 的 Label、ProgramArguments、RunAtLoad、KeepAlive 和日志路径', () => {
    const xml = servicePlist({
      nodePath: '/usr/local/bin/node',
      cliPath: '/opt/a&b<c>/dist/cli.js',
      logPath: '/Users/me/.pi-buddy/bridge.log',
    });
    assert.match(xml, /<key>Label<\/key>\s*<string>dev\.pibuddy\.bridge<\/string>/);
    assert.equal(SERVICE_LABEL, 'dev.pibuddy.bridge');
    const nodeAt = xml.indexOf('<string>/usr/local/bin/node</string>');
    const cliAt = xml.indexOf('<string>/opt/a&amp;b&lt;c&gt;/dist/cli.js</string>');
    assert.ok(nodeAt >= 0 && cliAt > nodeAt);
    assert.doesNotMatch(xml, /a&b<c>/);
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.doesNotMatch(xml, /<string>true<\/string>/);
    assert.equal(xml.split('/Users/me/.pi-buddy/bridge.log').length - 1, 2);
    assert.match(xml, /<key>StandardOutPath<\/key>/);
    assert.match(xml, /<key>StandardErrorPath<\/key>/);
  });

  it('status 文案包含是否已加载、pid 和日志路径', () => {
    assert.equal(
      formatServiceStatus(true, 4242, '/Users/me/.pi-buddy/bridge.log'),
      '已加载: 是\npid: 4242\n日志: /Users/me/.pi-buddy/bridge.log\n',
    );
    assert.equal(
      formatServiceStatus(false, undefined, '/Users/me/.pi-buddy/bridge.log'),
      '已加载: 否\npid: 无\n日志: /Users/me/.pi-buddy/bridge.log\n',
    );
    assert.equal(
      formatServiceStatus(true, undefined, '/tmp/bridge.log'),
      '已加载: 是\npid: 无\n日志: /tmp/bridge.log\n',
    );
  });
});
