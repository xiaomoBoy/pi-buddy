#include "agent_channel.h"
#include "mdns_lookup.h"

#include "application.h"
#include "assets/lang_config.h"
#include "board.h"
#include "settings.h"
#include "system_info.h"

#include <cJSON.h>
#include <cstring>
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
constexpr int64_t kArmDelayUs = 400LL * 1000;       // 请示刚出现的 0.4 秒内的语音不算
constexpr int kWarnLeftS = 10;                      // 剩这么多秒时再提醒一次
constexpr int kWarnMinTimeoutS = 20;                // 超时本来就很短的请示不提醒
// “允许执行”的识别把握至少要这么高（实测正常说话 0.30～0.43，命令词表的门槛是 0.2）；
// “拒绝”不设门槛，误触发也只是拦下命令
constexpr float kVoiceAllowMinProb = 0.25f;

constexpr uint32_t kMuted = 0xA9B0B5;
constexpr uint32_t kTeal = 0x4F90AA;
constexpr uint32_t kAmber = 0xF1BE58;
constexpr uint32_t kCream = 0xF8F5ED;
constexpr uint32_t kCoral = 0xE5645A;

// 设备内部的命令，和桥接程序发来的 JSON 一起排进收件箱
constexpr const char* kCmdAllow = "\x01" "allow:";   // 后面跟 via
constexpr const char* kCmdDeny = "\x01" "deny:";
constexpr const char* kCmdVoiceAllow = "\x01" "voice-allow:";   // 后面跟识别把握
constexpr const char* kCmdVoiceDeny = "\x01" "voice-deny";
constexpr const char* kCmdTouch = "\x01" "touch";
constexpr const char* kCmdClosed = "\x01" "closed";
constexpr const char* kCmdHoldOn = "\x01" "hold-on";
constexpr const char* kCmdHoldOff = "\x01" "hold-off";

int64_t Now() { return esp_timer_get_time(); }

std::string JsonString(cJSON* obj, const char* key) {
    cJSON* item = cJSON_GetObjectItem(obj, key);
    return cJSON_IsString(item) ? item->valuestring : "";
}

bool StartsWith(const std::string& text, const char* prefix) {
    return text.rfind(prefix, 0) == 0;
}

}  // namespace

// 由 prepare.py 叠加到小智 custom_wake_word.cc 里的钩子调用
extern "C" void pibuddy_on_voice_command(const char* action, float prob) {
    AgentChannel::GetInstance().OnVoiceCommand(action, prob);
}

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
    screen_.OnDecision([this](bool allow) { ReplyPermission(allow, Via::Touch); });
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

void AgentChannel::ReplyPermission(bool allow, Via via) {
    const char* name = via == Via::Touch ? "touch" : via == Via::Button ? "button" : "voice";
    Post(std::string(allow ? kCmdAllow : kCmdDeny) + name);
}

void AgentChannel::OnVoiceCommand(const char* action, float prob) {
    std::string name(action);
    ESP_LOGI(TAG, "voice command %s, prob %.3f", action, prob);
    if (name == "pibuddy_allow") Post(std::string(kCmdVoiceAllow) + std::to_string(prob));
    else if (name == "pibuddy_deny") Post(kCmdVoiceDeny);
}

void AgentChannel::OnBootDown() {
    armed_ = HasPendingPermission();
    if (!armed_) return;
    holding_ = true;
    Post(kCmdHoldOn);
}

bool AgentChannel::OnBootUp() {
    if (!holding_.exchange(false)) return false;
    Post(kCmdHoldOff);
    return true;
}

bool AgentChannel::SwallowClick() {
    return Now() - last_reply_us_ < 1500LL * 1000;
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
    auto state = app.GetDeviceState();
    if (state != kDeviceStateIdle) {
        ESP_LOGI(TAG, "sound %s skipped, device state %d", which, (int)state);
        return;
    }
    ESP_LOGI(TAG, "sound %s", which);
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
        if (voice_allow_at_us_ != 0 && now >= voice_allow_at_us_) {
            Decide(true, "voice");
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
    voice_allow_at_us_ = 0;
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
        // 听到“允许执行”后的等待期里点屏幕（按钮以外的地方），一律当拒绝
        if (voice_allow_at_us_ != 0) {
            Decide(false, "touch");
            return;
        }
        if (authed_) {
            cJSON* root = cJSON_CreateObject();
            cJSON_AddStringToObject(root, "type", "input");
            cJSON_AddStringToObject(root, "kind", "touch");
            SendJson(root);
        }
        return;
    }
    if (text == kCmdHoldOn || text == kCmdHoldOff) {
        // 开始按 BOOT 就取消语音的放行，交给按键决定
        if (text == kCmdHoldOn) {
            voice_allow_at_us_ = 0;
            voice_bar_shown_ = false;
        }
        screen_.ShowHold(text == kCmdHoldOn && HasPendingPermission(), kHoldMs);
        return;
    }
    if (StartsWith(text, kCmdAllow) || StartsWith(text, kCmdDeny)) {
        bool allow = StartsWith(text, kCmdAllow);
        Decide(allow, text.c_str() + strlen(allow ? kCmdAllow : kCmdDeny));
        return;
    }
    if (StartsWith(text, kCmdVoiceAllow) || text == kCmdVoiceDeny) {
        bool allow = text != kCmdVoiceDeny;
        bool ready;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            ready = !perm_id_.empty() && Now() - perm_shown_us_ > kArmDelayUs;
        }
        // 小智自己在说话或在听时不认：免得它的回答里正好有“允许执行”
        auto device_state = Application::GetInstance().GetDeviceState();
        const char* skip = !ready ? "no permission on screen"
                         : device_state != kDeviceStateIdle ? "device busy"
                         : holding_ ? "BOOT is held"
                         : nullptr;
        if (!skip && allow && strtof(text.c_str() + strlen(kCmdVoiceAllow), nullptr) < kVoiceAllowMinProb) {
            skip = "allow prob too low";
        }
        if (skip) {
            ESP_LOGI(TAG, "voice ignored, %s", skip);
            return;
        }
        if (!allow) {
            Decide(false, "voice");
        } else if (voice_allow_at_us_ == 0) {
            voice_allow_at_us_ = Now() + kVoiceConfirmMs * 1000LL;
            voice_bar_shown_ = true;
            screen_.ShowHold(true, kVoiceConfirmMs, "听到允许执行，点屏幕取消");
            ESP_LOGI(TAG, "voice allow, waiting %d ms for a cancel", kVoiceConfirmMs);
        }
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
        // permission 是桥接程序汇总出来的，不算会话状态；审批结束回到原状态时不再响一次
        if (state != "permission" && state != sound_state_) {
            if (state == "done") PlaySoundWhenIdle("success");
            if (state == "error") PlaySoundWhenIdle("error");
            sound_state_ = state;
        }
        state_ = state;
        detail_ = JsonString(root, "detail");
        if (state_ != "permission") {
            std::lock_guard<std::mutex> lock(mutex_);
            perm_id_.clear();
            voice_allow_at_us_ = 0;
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
            perm_project_ = JsonString(root, "project");
            cJSON* q = cJSON_GetObjectItem(root, "queue_len");
            queue_len_ = cJSON_IsNumber(q) ? q->valueint : 0;
            if (fresh) {
                cJSON* t = cJSON_GetObjectItem(root, "timeout_s");
                perm_timeout_s_ = cJSON_IsNumber(t) ? t->valueint : 120;
                perm_deadline_us_ = Now() + perm_timeout_s_ * 1000000LL;
                perm_shown_us_ = Now();
                perm_warned_ = false;
            }
        }
        if (fresh) {
            voice_allow_at_us_ = 0;
            PlaySoundWhenIdle("popup");
        }
        last_activity_us_ = Now();
        sleeping_ = false;
    } else if (type == "permission_cancel") {
        std::lock_guard<std::mutex> lock(mutex_);
        if (JsonString(root, "id") == perm_id_) {
            perm_id_.clear();
            voice_allow_at_us_ = 0;
        }
    }
    cJSON_Delete(root);
}

void AgentChannel::Decide(bool allow, const char* via) {
    voice_allow_at_us_ = 0;
    voice_bar_shown_ = false;
    last_reply_us_ = Now();
    screen_.ShowHold(false, kHoldMs);
    std::string id;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        id = perm_id_;
        perm_id_.clear();
    }
    if (id.empty()) return;
    flash_allow_ = allow;
    flash_text_ = allow ? "已允许，pi 继续执行" : "已拒绝，命令不会执行";
    flash_until_us_ = Now() + 1500LL * 1000;
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "permission_reply");
    cJSON_AddStringToObject(root, "id", id.c_str());
    cJSON_AddStringToObject(root, "decision", allow ? "allow" : "deny");
    cJSON_AddStringToObject(root, "via", via);
    SendJson(root);
    ESP_LOGI(TAG, "permission %s via %s", allow ? "allowed" : "denied", via);
}

void AgentChannel::Refresh() {
    auto device_state = Application::GetInstance().GetDeviceState();
    std::string perm_id, tool, summary, project;
    int queue_len;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        perm_id = perm_id_;
        tool = perm_tool_;
        summary = perm_summary_;
        project = perm_project_;
        queue_len = queue_len_;
    }
    bool has_perm = authed_ && !perm_id.empty();
    // 语音确认被别的原因打断（请示被撤、换了一条、断线），收起进度条
    if (voice_bar_shown_ && voice_allow_at_us_ == 0) {
        voice_bar_shown_ = false;
        screen_.ShowHold(false, kHoldMs);
    }
    if (!has_perm && state_ == "idle" && !sleeping_ && Now() - last_activity_us_ > kSleepAfterUs) {
        sleeping_ = true;
    }

    using Face = BuddyScreen::Face;
    Face face = Face::Idle;
    std::string status, detail;
    uint32_t accent = kMuted;
    bool flashing = !has_perm && Now() < flash_until_us_;
    std::string corner;
    uint32_t corner_color = kMuted;
    if (pairing_) {
        status = "配对码 " + pair_code_;
        detail = "在 Mac 上运行 pi-buddy-bridge pair " + pair_code_;
        accent = kAmber;
    } else if (has_perm) {
        face = Face::Permission;
        status = tool + " · " + summary;
        accent = kAmber;
        int64_t left = (perm_deadline_us_ - Now()) / 1000000;
        if (left < 0) left = 0;
        bool near_timeout = perm_timeout_s_ >= kWarnMinTimeoutS && left <= kWarnLeftS;
        // 一行最多放 14 个字左右；平时每 3 秒在按键和语音两种说明之间轮换
        if (voice_allow_at_us_ != 0) {
            detail = "听到允许，点屏幕可取消";
        } else if (near_timeout) {
            detail = "快超时了，不回答就算拒绝";
        } else if ((Now() - perm_shown_us_) / 3000000 % 2 == 0) {
            detail = "BOOT：按住允许，短按拒绝";
        } else {
            detail = "也可以说：允许执行 / 拒绝";
        }
        if (near_timeout && !perm_warned_) {
            perm_warned_ = true;
            PlaySoundWhenIdle("popup");
        }
        corner = (project.empty() ? "" : project + " · ") + std::to_string(left) + "s";
        if (queue_len > 0) corner += "  +" + std::to_string(queue_len);
        if (near_timeout) {
            corner_color = kCoral;
            if (Now() / 500000 % 2) corner.clear();   // 闪烁
        }
    } else if (flashing) {
        face = flash_allow_ ? Face::Done : Face::Idle;
        status = flash_text_;
        accent = flash_allow_ ? kTeal : kCoral;
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
    std::string corner_key = corner + "|" + std::to_string(corner_color);
    if (corner_key != corner_) {
        screen_.SetCorner(corner, corner_color);
        corner_ = corner_key;
    }
    // 有审批时一定显示；否则只在小智待机（没在听、没在说）时显示 P 仔
    bool show = has_perm || ((authed_ || pairing_) && device_state == kDeviceStateIdle);
    screen_.SetVisible(show);
}
