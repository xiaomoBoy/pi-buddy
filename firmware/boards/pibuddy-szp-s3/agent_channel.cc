#include "agent_channel.h"
#include "mdns_lookup.h"

#include "application.h"
#include "assets/lang_config.h"
#include "board.h"
#include "settings.h"
#include "system_info.h"

#include <cJSON.h>
#include <esp_app_desc.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <freertos/idf_additions.h>
#include <web_socket.h>

#define TAG "PiBuddy"

namespace {

constexpr const char* kBoardType = "pibuddy-szp-s3";
constexpr const char* kService = "_pibuddy._tcp.local";
constexpr int kTaskStack = 8192;              // 放在 PSRAM
constexpr int64_t kSleepAfterUs = 5LL * 60 * 1000 * 1000;
constexpr int64_t kPingEveryUs = 15LL * 1000 * 1000;
constexpr int64_t kPongTimeoutUs = 45LL * 1000 * 1000;
constexpr int64_t kMemLogEveryUs = 60LL * 1000 * 1000;

constexpr uint32_t kMuted = 0xA9B0B5;
constexpr uint32_t kTeal = 0x4F90AA;
constexpr uint32_t kAmber = 0xF1BE58;
constexpr uint32_t kCream = 0xF8F5ED;
constexpr uint32_t kCoral = 0xE5645A;

// 设备内部的命令，和桥接程序发来的 JSON 一起排进收件箱
constexpr const char* kCmdAllow = "\x01" "allow";
constexpr const char* kCmdDeny = "\x01" "deny";
constexpr const char* kCmdTouch = "\x01" "touch";
constexpr const char* kCmdClosed = "\x01" "closed";

int64_t Now() { return esp_timer_get_time(); }

std::string JsonString(cJSON* obj, const char* key) {
    cJSON* item = cJSON_GetObjectItem(obj, key);
    return cJSON_IsString(item) ? item->valuestring : "";
}

}  // namespace

void AgentChannel::Start(Display* display) {
    // 后台任务的栈在 PSRAM，读写 flash（包括 NVS）时 PSRAM 不可用会断言重启，
    // 所以 NVS 只在这里（主任务）读，之后的写入也都交给主任务
    {
        Settings settings("pibuddy");
        token_ = settings.GetString("token");
        manual_bridge_ = settings.GetString("bridge");
    }
    screen_.Init(display);
    screen_.OnTouch([this]() { Post(kCmdTouch); });
    // 栈放 PSRAM，不占紧张的内部内存；NVS 写入要关 cache，所以统一交给主任务做
    xTaskCreatePinnedToCoreWithCaps(TaskEntry, "pibuddy", kTaskStack, this, 3, &task_, tskNO_AFFINITY,
                                    MALLOC_CAP_SPIRAM);
}

void AgentChannel::TaskEntry(void* arg) {
    static_cast<AgentChannel*>(arg)->Run();
}

void AgentChannel::Post(std::string item) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        inbox_.push_back(std::move(item));
    }
    if (task_) xTaskNotifyGive(task_);
}

bool AgentChannel::HasPendingPermission() {
    std::lock_guard<std::mutex> lock(mutex_);
    return !perm_id_.empty();
}

void AgentChannel::ReplyPermission(bool allow) {
    Post(allow ? kCmdAllow : kCmdDeny);
}

bool AgentChannel::SendTask(const std::string& text, std::string& error) {
    if (!authed_) {
        error = "pi-buddy bridge is not connected（电脑上的 pi 没连上）";
        return false;
    }
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "task");
    cJSON_AddStringToObject(root, "text", text.c_str());
    if (!SendJson(root)) {
        error = "send failed（发送失败）";
        return false;
    }
    return true;
}

bool AgentChannel::SendJson(cJSON* root) {
    char* text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    bool ok = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (ws_ && ws_->IsConnected()) ok = ws_->Send(text);
    }
    cJSON_free(text);
    return ok;
}

void AgentChannel::SendHello() {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "hello");
    cJSON_AddNumberToObject(root, "v", 1);
    cJSON_AddStringToObject(root, "token", token_.c_str());
    cJSON_AddStringToObject(root, "device_id", SystemInfo::GetMacAddress().c_str());
    cJSON_AddStringToObject(root, "fw", esp_app_get_description()->version);
    cJSON_AddStringToObject(root, "board", kBoardType);
    SendJson(root);
}

void AgentChannel::SendPairRequest() {
    char code[8];
    snprintf(code, sizeof(code), "%06lu", (unsigned long)(esp_random() % 1000000));
    pair_code_ = code;
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "pair_request");
    cJSON_AddNumberToObject(root, "v", 1);
    cJSON_AddStringToObject(root, "device_id", SystemInfo::GetMacAddress().c_str());
    cJSON_AddStringToObject(root, "code", code);
    if (SendJson(root)) {
        pairing_ = true;
        ESP_LOGI(TAG, "pairing code %s", code);
    }
}

void AgentChannel::LogMemory(const char* when) {
    ESP_LOGI("pibuddy-mem", "%s: internal free=%u largest=%u, psram free=%u", when,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

void AgentChannel::PlaySoundWhenIdle(const char* which) {
    auto& app = Application::GetInstance();
    if (app.GetDeviceState() != kDeviceStateIdle) return;
    std::string name(which);
    app.Schedule([name]() {
        auto& app = Application::GetInstance();
        if (name == "popup") app.PlaySound(Lang::Sounds::OGG_POPUP);
        else if (name == "success") app.PlaySound(Lang::Sounds::OGG_SUCCESS);
        else if (name == "error") app.PlaySound(Lang::Sounds::OGG_EXCLAMATION);
    });
}

void AgentChannel::Run() {
    auto& app = Application::GetInstance();
    // 等小智联网、激活完成（第一次进入待机）再开始
    while (app.GetDeviceState() != kDeviceStateIdle) {
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    LogMemory("start");
    last_activity_us_ = Now();
    int backoff_s = 1;
    while (true) {
        std::string ip;
        uint16_t port = 0;
        if (Discover(ip, port)) {
            Serve(ip, port);
            backoff_s = authed_ ? 1 : std::min(backoff_s * 2, 30);
            authed_ = false;
        } else {
            backoff_s = std::min(backoff_s * 2, 30);
        }
        vTaskDelay(pdMS_TO_TICKS(backoff_s * 1000));
    }
}

bool AgentChannel::Discover(std::string& ip, uint16_t& port) {
    // NVS 里手动设置的地址优先，格式 192.168.1.10:4317
    const std::string& manual = manual_bridge_;
    if (!manual.empty()) {
        auto colon = manual.find(':');
        ip = manual.substr(0, colon);
        port = colon == std::string::npos ? 4317 : (uint16_t)atoi(manual.c_str() + colon + 1);
        return true;
    }
    return MdnsLookup(kService, ip, port, 3000);
}

void AgentChannel::Serve(const std::string& ip, uint16_t port) {
    auto network = Board::GetInstance().GetNetwork();
    auto ws = network->CreateWebSocket(2);
    if (!ws) return;
    ws->OnData([this](const char* data, size_t len, bool binary) {
        if (!binary) Post(std::string(data, len));
    });
    ws->OnDisconnected([this]() { Post(kCmdClosed); });
    ws->OnPong([this](const char*, size_t) { last_pong_us_ = Now(); });

    std::string url = "ws://" + ip + ":" + std::to_string(port) + "/v1/device";
    if (!ws->Connect(url.c_str())) {
        ESP_LOGW(TAG, "connect %s failed", url.c_str());
        return;
    }
    ESP_LOGI(TAG, "connected %s", url.c_str());
    {
        std::lock_guard<std::mutex> lock(mutex_);
        ws_ = std::move(ws);
        inbox_.clear();
    }
    disconnected_ = false;
    int64_t opened = Now();
    bool hello_sent = false;
    if (!token_.empty()) {
        SendHello();
        hello_sent = true;
    } else {
        SendPairRequest();
    }
    last_pong_us_ = Now();
    int64_t next_ping = Now() + kPingEveryUs;
    int64_t next_mem = Now() + kMemLogEveryUs;

    while (!disconnected_) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(200));
        while (true) {
            std::string item;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (inbox_.empty()) break;
                item = std::move(inbox_.front());
                inbox_.pop_front();
            }
            HandleMessage(item);
            if (!pairing_ && !token_.empty()) hello_sent = true;  // 配对成功后也发了 hello
        }
        int64_t now = Now();
        if (now >= next_ping) {
            std::lock_guard<std::mutex> lock(mutex_);
            if (ws_) ws_->Ping();
            next_ping = now + kPingEveryUs;
        }
        if (now - last_pong_us_ > kPongTimeoutUs) {
            ESP_LOGW(TAG, "bridge not answering ping, reconnecting");
            break;
        }
        if (now >= next_mem) {
            LogMemory("periodic");
            next_mem = now + kMemLogEveryUs;
        }
        Refresh();
    }

    // 带着 token 打招呼后很快被断开，多半是 token 失效（桥接程序重置过）；连续两次就重新配对
    if (hello_sent && !authed_ && Now() - opened < 5LL * 1000 * 1000) {
        if (++bad_hello_ >= 2) {
            ESP_LOGW(TAG, "token rejected, will pair again");
            token_.clear();
            bad_hello_ = 0;
            Application::GetInstance().Schedule([]() {
                Settings settings("pibuddy", true);
                settings.EraseKey("token");
            });
        }
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (ws_) ws_->Close();
        ws_.reset();
        perm_id_.clear();
    }
    pairing_ = false;
    authed_ = false;
    ESP_LOGI(TAG, "disconnected");
    Refresh();
}

void AgentChannel::HandleMessage(const std::string& text) {
    if (text == kCmdClosed) {
        disconnected_ = true;
        return;
    }
    if (text == kCmdTouch) {
        last_activity_us_ = Now();
        sleeping_ = false;
        if (authed_) {
            cJSON* root = cJSON_CreateObject();
            cJSON_AddStringToObject(root, "type", "input");
            cJSON_AddStringToObject(root, "kind", "touch");
            SendJson(root);
        }
        return;
    }
    if (text == kCmdAllow || text == kCmdDeny) {
        std::string id;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            id = perm_id_;
            perm_id_.clear();
        }
        if (id.empty()) return;
        cJSON* root = cJSON_CreateObject();
        cJSON_AddStringToObject(root, "type", "permission_reply");
        cJSON_AddStringToObject(root, "id", id.c_str());
        cJSON_AddStringToObject(root, "decision", text == kCmdAllow ? "allow" : "deny");
        SendJson(root);
        ESP_LOGI(TAG, "permission %s", text == kCmdAllow ? "allowed" : "denied");
        return;
    }

    cJSON* root = cJSON_Parse(text.c_str());
    if (!root) return;
    std::string type = JsonString(root, "type");
    if (type == "hello_ack") {
        authed_ = true;
        bad_hello_ = 0;
        ESP_LOGI(TAG, "online, bridge %s", JsonString(root, "bridge_version").c_str());
        LogMemory("online");
    } else if (type == "pair_ok") {
        token_ = JsonString(root, "token");
        pairing_ = false;
        std::string token = token_;
        Application::GetInstance().Schedule([token]() {
            Settings settings("pibuddy", true);
            settings.SetString("token", token);
        });
        ESP_LOGI(TAG, "paired");
        SendHello();
    } else if (type == "state") {
        std::string state = JsonString(root, "state");
        if (state != state_) {
            if (state == "done") PlaySoundWhenIdle("success");
            if (state == "error") PlaySoundWhenIdle("error");
        }
        state_ = state;
        detail_ = JsonString(root, "detail");
        if (state_ != "permission") {
            std::lock_guard<std::mutex> lock(mutex_);
            perm_id_.clear();
        }
        last_activity_us_ = Now();
        sleeping_ = false;
    } else if (type == "permission") {
        std::string id = JsonString(root, "id");
        bool fresh;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            fresh = id != perm_id_;
            perm_id_ = id;
            perm_tool_ = JsonString(root, "tool");
            perm_summary_ = JsonString(root, "summary");
            cJSON* q = cJSON_GetObjectItem(root, "queue_len");
            queue_len_ = cJSON_IsNumber(q) ? q->valueint : 0;
        }
        if (fresh) PlaySoundWhenIdle("popup");
        last_activity_us_ = Now();
        sleeping_ = false;
    } else if (type == "permission_cancel") {
        std::lock_guard<std::mutex> lock(mutex_);
        if (JsonString(root, "id") == perm_id_) perm_id_.clear();
    }
    cJSON_Delete(root);
}

void AgentChannel::Refresh() {
    auto device_state = Application::GetInstance().GetDeviceState();
    std::string perm_id, tool, summary;
    int queue_len;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        perm_id = perm_id_;
        tool = perm_tool_;
        summary = perm_summary_;
        queue_len = queue_len_;
    }
    bool has_perm = authed_ && !perm_id.empty();
    if (!has_perm && state_ == "idle" && !sleeping_ && Now() - last_activity_us_ > kSleepAfterUs) {
        sleeping_ = true;
    }

    using Face = BuddyScreen::Face;
    Face face = Face::Idle;
    std::string status, detail;
    uint32_t accent = kMuted;
    if (pairing_) {
        status = "配对码 " + pair_code_;
        detail = "在 Mac 上运行 pi-buddy-bridge pair " + pair_code_;
        accent = kAmber;
    } else if (has_perm) {
        face = Face::Permission;
        status = tool + " · " + summary;
        detail = "短按允许 · 按住拒绝";
        if (queue_len > 0) detail += " · 还有 " + std::to_string(queue_len) + " 条";
        accent = kAmber;
    } else if (sleeping_) {
        face = Face::Sleep;
        status = "睡着了";
        detail = "闲置 5 分钟 · 摸一下屏幕叫醒";
    } else if (state_ == "thinking") {
        face = Face::Thinking; status = "思考中"; detail = detail_; accent = kTeal;
    } else if (state_ == "working") {
        face = Face::Working; status = "干活中"; detail = detail_; accent = kTeal;
    } else if (state_ == "done") {
        face = Face::Done; status = "完成"; detail = detail_; accent = kCream;
    } else if (state_ == "error") {
        face = Face::Error; status = "出错了"; detail = detail_; accent = kCoral;
    } else {
        status = "待机";
        detail = detail_.empty() ? "pi 在等你的下一个任务" : detail_;
    }

    std::string key = std::to_string((int)face) + "|" + status + "|" + detail;
    if (key != rendered_) {
        screen_.Render(face, status, detail, accent);
        rendered_ = key;
    }
    // 有审批时一定显示；否则只在小智待机（没在听、没在说）时显示 P 仔
    bool show = has_perm || ((authed_ || pairing_) && device_state == kDeviceStateIdle);
    screen_.SetVisible(show);
}
