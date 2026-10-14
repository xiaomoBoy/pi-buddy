#ifndef PIBUDDY_AGENT_CHANNEL_H
#define PIBUDDY_AGENT_CHANNEL_H

#include "buddy_screen.h"

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>

class Display;
class WebSocket;
struct cJSON;

// 智能体通道：连 Mac 上的 pi-buddy 桥接程序（协议见 docs/protocol.md v1.1）。
// 和小智连官方云的那条连接互不影响，桥接程序没开时只在后台安静重试。
class AgentChannel {
public:
    static AgentChannel& GetInstance() {
        static AgentChannel instance;
        return instance;
    }

    void Start(Display* display);

    // 以下接口可以在任意任务里调用
    bool HasPendingPermission();
    void ReplyPermission(bool allow);
    bool SendTask(const std::string& text, std::string& error);
    // BOOT 键按下、松开（请示时显示按住进度条）；松开时如果正在按住计时，返回 true
    void OnBootDown();
    bool OnBootUp();
    // 刚回复完审批的 1.5 秒内，多出来的按键不交给小智，免得误开语音对话
    bool SwallowClick();
    // 这次按键是不是在请示出现之后才按下的；只有这样的按键才算审批（提前按住的不算）
    bool ConsumeArmed() { return armed_.exchange(false); }

    static constexpr int kHoldMs = 1000;   // 按住多久算“允许”，与板型里的 long_press_time 一致

private:
    AgentChannel() = default;

    static void TaskEntry(void* arg);
    void Run();
    bool Discover(std::string& ip, uint16_t& port);
    void Serve(const std::string& ip, uint16_t port);
    void Post(std::string item);
    void HandleMessage(const std::string& text);
    bool SendJson(cJSON* root);
    void SendHello();
    void SendPairRequest();
    void Refresh();
    void PlaySoundWhenIdle(const char* which);
    void LogMemory(const char* when);

    BuddyScreen screen_;
    TaskHandle_t task_ = nullptr;
    std::mutex mutex_;                 // 保护 inbox_、ws_ 和审批字段
    std::deque<std::string> inbox_;
    std::unique_ptr<WebSocket> ws_;
    bool disconnected_ = false;
    bool authed_ = false;
    bool pairing_ = false;
    std::string token_;
    std::string manual_bridge_;        // NVS 里手动设置的桥接地址，格式 ip:port
    std::string pair_code_;
    int bad_hello_ = 0;

    std::string state_ = "idle";
    std::string detail_;
    std::string perm_id_;
    std::string perm_tool_;
    std::string perm_summary_;
    int queue_len_ = 0;
    int64_t perm_deadline_us_ = 0;
    std::string flash_text_;           // 回复审批后短暂显示“已允许”“已拒绝”
    bool flash_allow_ = false;
    int64_t flash_until_us_ = 0;
    std::string corner_;

    int64_t last_activity_us_ = 0;
    int64_t last_pong_us_ = 0;
    bool sleeping_ = false;
    std::atomic<bool> holding_{false};
    std::atomic<bool> armed_{false};
    std::string sound_state_ = "idle";   // 上一次响提示音时的会话状态，审批结束回到原状态时不重复响
    std::atomic<int64_t> last_reply_us_{0};
    std::string rendered_;             // 上一次画上去的内容，没变化就不重画
};

#endif
