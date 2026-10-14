#ifndef PIBUDDY_BUDDY_SCREEN_H
#define PIBUDDY_BUDDY_SCREEN_H

#include <functional>
#include <string>

#include <lvgl.h>

class Display;

// P 仔全屏界面：画在 LVGL 顶层（lv_layer_top），盖在小智界面上面，隐藏时小智界面照常显示。
// 形象与 assets/mascot/draw.py 一致：S=7 网格，原点 (112, 44)，y=196 起是状态栏。
class BuddyScreen {
public:
    // 与 draw.py 的 7 种状态一一对应；配对时用 Idle 的样子，状态栏显示配对码
    enum class Face { Idle, Thinking, Working, Permission, Done, Error, Sleep };

    void Init(Display* display);
    // 调用方不需要持有显示锁，这里自己加锁
    void Render(Face face, const std::string& status, const std::string& detail, uint32_t accent);
    void SetVisible(bool visible);
    bool visible() const { return visible_; }
    void OnTouch(std::function<void()> callback) { on_touch_ = std::move(callback); }
    // 请示时屏幕下方的“允许”“拒绝”两个触摸按钮
    void OnDecision(std::function<void(bool allow)> callback) { on_decision_ = std::move(callback); }
    // 按住 BOOT 时的进度条：hold_ms 内填满，填满即拒绝；松开提前结束
    void ShowHold(bool show, int hold_ms);
    // 左上角的小字（请示时显示项目名和剩余秒数），空字符串表示不显示
    void SetCorner(const std::string& text, uint32_t color);

private:
    void DrawMascot(Face face);
    void FillCell(int x, int y, uint32_t rgb, int dx = 0, int dy = 0);
    void FillRect(int x, int y, int w, int h, uint32_t rgb);

    Display* display_ = nullptr;
    lv_obj_t* root_ = nullptr;
    lv_obj_t* canvas_ = nullptr;
    lv_obj_t* accent_ = nullptr;
    lv_obj_t* status_ = nullptr;
    lv_obj_t* detail_ = nullptr;
    uint16_t* pixels_ = nullptr;
    lv_obj_t* buttons_ = nullptr;
    lv_obj_t* corner_ = nullptr;
    uint32_t buttons_shown_at_ = 0;   // lv_tick；按钮刚出现的 0.4 秒内的点击不算
    lv_obj_t* hold_ = nullptr;
    lv_obj_t* hold_bar_ = nullptr;
    bool visible_ = false;
    std::function<void()> on_touch_;
    std::function<void(bool)> on_decision_;
};

#endif
