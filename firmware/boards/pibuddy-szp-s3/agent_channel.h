#ifndef PIBUDDY_AGENT_CHANNEL_H
#define PIBUDDY_AGENT_CHANNEL_H

#include "buddy_screen.h"

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

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

    int64_t last_activity_us_ = 0;
    int64_t last_pong_us_ = 0;
    bool sleeping_ = false;
    std::string rendered_;             // 上一次画上去的内容，没变化就不重画
};

#endif
