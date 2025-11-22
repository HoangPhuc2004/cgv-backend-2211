require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./middleware/auth');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// ==================== DATABASE ====================
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ==================== HÀM XỬ LÝ NGÀY VIỆT NAM ====================
function getQueryDate(dateString) {
    const nowInVietnam = () => {
        const now = new Date();
        const offset = 7 * 60;
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        return new Date(utc + (offset * 60000));
    };

    const today = nowInVietnam();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    if (!dateString) return todayStr;

    const lower = dateString.toLowerCase().trim();

    if (lower.includes('hôm nay') || lower.includes('today') || lower === '') return todayStr;
    if (lower.includes('ngày mai') || lower.includes('tomorrow')) return tomorrowStr;

    const match = lower.match(/(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{4}))?/);
    if (match) {
        let day = parseInt(match[1], 10);
        let month = parseInt(match[2], 10) - 1;
        let year = match[3] ? parseInt(match[3], 10) : today.getFullYear();
        const date = new Date(year, month, day);
        date.setHours(0, 0, 0, 0);
        return date.toISOString().split('T')[0];
    }

    return todayStr;
}

// ==================== TOOLS ====================
async function get_showtimes_for_movie(args) {
    console.log("[TOOL] get_showtimes_for_movie called with:", args);

    const { movie_title, city_name, cinema_name, date } = args || {};
    const queryDate = getQueryDate(date || "hôm nay");

    if (!movie_title) {
        return JSON.stringify({ message: "Bạn muốn xem phim gì nè?" });
    }

    try {
        const movieSql = `
            SELECT movie_id, title FROM movies 
            WHERE LOWER(title) ILIKE $1 OR LOWER(title) ILIKE $2
            LIMIT 1
        `;
        const { rows: movieRows } = await pool.query(movieSql, [
            `%${movie_title.toLowerCase()}%`,
            `%${movie_title.toLowerCase().replace(/\s+/g, '')}%`
        ]);

        if (movieRows.length === 0) {
            return JSON.stringify({ message: `Hiện tại **${movie_title}** chưa có lịch chiếu nha\nMình sẽ báo ngay khi có nhé!` });
        }

        const movieId = movieRows[0].movie_id;
        const realTitle = movieRows[0].title;

        let showtimeSql = `
            SELECT 
                s.showtime_id,
                TO_CHAR(s.start_time AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') as time,
                s.start_time AT TIME ZONE 'Asia/Ho_Chi_Minh' as full_time,
                s.ticket_price,
                c.name as cinema_name,
                c.city,
                m.features
            FROM showtimes s
            JOIN cinemas c ON s.cinema_id = c.cinema_id
            JOIN movies m ON s.movie_id = m.movie_id
            WHERE s.movie_id = $1
              AND (s.start_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $2
              AND s.start_time > NOW() AT TIME ZONE 'UTC'
        `;

        let params = [movieId, queryDate];
        let idx = 3;

        if (city_name) {
            showtimeSql += ` AND LOWER(c.city) LIKE LOWER($${idx++})`;
            params.push(`%${city_name}%`);
        }
        if (cinema_name) {
            showtimeSql += ` AND LOWER(c.name) LIKE LOWER($${idx++})`;
            params.push(`%${cinema_name}%`);
        }

        showtimeSql += ` ORDER BY s.start_time`;

        const { rows: showtimes } = await pool.query(showtimeSql, params);

        if (showtimes.length > 0) {
            return JSON.stringify({
                found_movie: realTitle,
                date_vn: queryDate,
                showtimes: showtimes.map(s => ({
                    showtime_id: s.showtime_id,
                    time: s.time,
                    cinema_name: s.cinema_name,
                    price: Number(s.ticket_price).toLocaleString('vi-VN') + 'đ',
                    full_time: s.full_time,
                    features: s.features || []
                }))
            });
        } else {
            const dateStr = new Date(queryDate).toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric' });
            return JSON.stringify({
                message: `**${realTitle}** hiện chưa có suất chiếu vào **${dateStr}** nha\nNhưng phim đang rất hot, mình sẽ báo ngay khi có lịch nhé!`
            });
        }
    } catch (error) {
        console.error("Lỗi get_showtimes_for_movie:", error);
        return JSON.stringify({ message: "Bot đang lag xíu, bạn thử lại nha!" });
    }
}

async function get_movies_at_cinema(cinema_name, date) {
    const queryDate = getQueryDate(date);
    const { rows } = await pool.query(`
        SELECT m.title, m.genre, COUNT(s.showtime_id) as showtime_count
        FROM showtimes s
        JOIN movies m ON s.movie_id = m.movie_id
        JOIN cinemas c ON s.cinema_id = c.cinema_id
        WHERE c.name ILIKE $1 AND s.start_time::date = $2 AND s.start_time > NOW()
        GROUP BY m.title, m.genre ORDER BY m.title
    `, [`%${cinema_name}%`, queryDate]);
    return rows.length ? JSON.stringify(rows) : JSON.stringify({ message: `Không có phim nào tại ${cinema_name} ngày ${queryDate}.` });
}

async function get_movie_details(movie_title) {
    const { rows } = await pool.query(`
        SELECT title, description, genre, rating, director, cast_members, duration_minutes
        FROM movies WHERE title ILIKE $1 LIMIT 1
    `, [`%${movie_title}%`]);
    return rows.length ? JSON.stringify(rows[0]) : JSON.stringify({ message: `Không tìm thấy phim "${movie_title}".` });
}

async function get_movie_recommendations_based_on_history(userId) {
    if (!userId) return JSON.stringify({ error: "Không xác định người dùng." });
    try {
        const { data } = await axios.get(`http://localhost:8000/recommendations/${userId}`);
        return JSON.stringify(data);
    } catch (e) {
        return JSON.stringify({ error: "Không thể tạo đề xuất phim lúc này." });
    }
}

async function search_cgv_policies(args) {
    const { query } = args || {};
    console.log(`[Tool] search_cgv_policies → query: "${query}"`);

    if (!query || query.trim() === '') {
        return JSON.stringify({ message: "Bạn chưa hỏi gì về chính sách CGV." });
    }

    try {
        const url = `http://localhost:8000/policy-search?query=${encodeURIComponent(query.trim())}`;
        const { data } = await axios.get(url, { timeout: 12000 });

        if (data.context && data.context.trim()) {
            return JSON.stringify({
                message: "Đây là thông tin chính thức từ CGV:",
                context: data.context.trim()
            });
        }
        return JSON.stringify({ message: "Tôi không tìm thấy thông tin phù hợp trong quy định CGV." });
    } catch (e) {
        console.error("Lỗi search_cgv_policies:", e.message);
        return JSON.stringify({ message: "Hệ thống tra cứu chính sách đang tạm nghỉ. Thử lại sau ít phút nhé!" });
    }
}

// ==================== DANH SÁCH TOOLS CHO GROQ ====================
const tools = [
    {
        type: "function",
        function: {
            name: "get_showtimes_for_movie",
            description: "Lấy suất chiếu phim theo tên phim, ngày, thành phố hoặc rạp",
            parameters: { type: "object", properties: { movie_title: { type: "string" }, date: { type: "string" }, city_name: { type: "string" }, cinema_name: { type: "string" } }, required: ["movie_title"] }
        }
    },
    {
        type: "function",
        function: {
            name: "get_movies_at_cinema",
            description: "Lấy danh sách phim đang chiếu tại một rạp",
            parameters: { type: "object", properties: { cinema_name: { type: "string" }, date: { type: "string" } }, required: ["cinema_name"] }
        }
    },
    {
        type: "function",
        function: {
            name: "get_movie_details",
            description: "Lấy thông tin chi tiết phim",
            parameters: { type: "object", properties: { movie_title: { type: "string" } }, required: ["movie_title"] }
        }
    },
    {
        type: "function",
        function: {
            name: "get_movie_recommendations_based_on_history",
            description: "Đề xuất phim dựa trên lịch sử xem",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "search_cgv_policies",
            description: "Tra cứu mọi chính sách CGV",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    }
];

// ==================== SYSTEM PROMPT ====================
const getSystemPrompt_Normal = (user, movies, cities, cinemas) => `
Bạn là CGV-Bot, trợ lý đặt vé phim cực kỳ dễ thương của CGV Việt Nam.
Người dùng: ${user.username || "Khách"}.

Phim đang chiếu: ${movies}
Thành phố: ${cities}
Rạp: ${cinemas}

QUY TẮC:
- Hỏi suất chiếu → gọi get_showtimes_for_movie
- Hỏi phim tại rạp → gọi get_movies_at_cinema
- Hỏi chi tiết phim → gọi get_movie_details
- Hỏi phim hay → gọi get_movie_recommendations_based_on_history
- Hỏi chính sách CGV → gọi search_cgv_policies
- Không bịa thông tin.
`;

const getSystemPrompt_ChotVe = () => `Chỉ trả về JSON:
{"choice_index": số} hoặc {"choice_time": "13:45"} hoặc {"choice_index": -1}
Không nói gì thêm.`;

// ==================== HÀM LÀM ĐẸP (nếu bạn có thì thêm vào, không thì để vậy) ====================
function beautifyMovieResponse(text) {
    return text; // bạn có thể thêm logic in đậm, emoji ở đây
}

// ==================== API CHAT – PHIÊN BẢN HOÀN HẢO, CÓ NÚT ĐẶT VÉ ====================
app.post('/api/chat', authMiddleware, async (req, res) => {
    const { message, conversation_id } = req.body;
    const userId = req.user?.id;
    let convId = conversation_id || `user_${userId || 'guest'}_${Date.now()}`;

    if (!message || message.trim() === '') {
        return res.status(400).json({ message: "Tin nhắn trống" });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Lưu tin nhắn user
        if (userId) {
            await client.query(
                `INSERT INTO ChatHistory (conversation_id, user_id, sender, content) VALUES ($1,$2,'user',$3)`,
                [convId, userId, message]
            );
        }

        // Lấy lịch sử
        let history = [];
        if (userId) {
            const h = await client.query(
                `SELECT sender, content, metadata FROM ChatHistory WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 30`,
                [convId]
            );
            history = h.rows.map(r => {
                if (r.sender === 'assistant' && r.metadata?.tool_calls) return { role: 'assistant', content: r.content || null, tool_calls: r.metadata.tool_calls };
                if (r.sender === 'tool') return { role: 'tool', tool_call_id: r.metadata.tool_call_id, name: r.metadata.name, content: r.content };
                return { role: r.sender, content: r.content };
            });
        }

        // RAG data
        const userRow = userId 
            ? (await client.query('SELECT username FROM Users WHERE user_id = $1', [userId])).rows[0] || { username: 'Khách' }
            : { username: 'Khách' };

        const moviesRes = await client.query('SELECT title FROM Movies WHERE release_date <= CURRENT_DATE');
        const movies = moviesRes.rows.map(r => r.title).join(', ');

        const citiesRes = await client.query('SELECT DISTINCT city FROM Cinemas');
        const cities = citiesRes.rows.map(r => r.city).join(', ');

        const cinemasRes = await client.query('SELECT name FROM Cinemas');
        const cinemas = cinemasRes.rows.map(r => r.name).join(', ');

        const isChotVe = history.length >= 2 && 
            history[history.length - 2].role === 'assistant' && 
            (history[history.length - 2].content || '').toLowerCase().includes('suất nào');

        // Gọi lần 1: xem có cần tool không
        const completion = await groq.chat.completions.create({
            model: "moonshotai/kimi-k2-instruct-0905",
            messages: [
                { role: "system", content: isChotVe ? getSystemPrompt_ChotVe() : getSystemPrompt_Normal(userRow, movies, cities, cinemas) },
                ...history,
                { role: "user", content: message }
            ],
            tools: isChotVe ? undefined : tools,
            tool_choice: isChotVe ? "none" : "auto",
            response_format: isChotVe ? { type: "json_object" } : undefined,
            temperature: 0.7
        });

        const msg = completion.choices[0].message;
        let finalReply = "";
        let bookingDataForFrontend = null;

        // ==================== CÓ TOOL CALL → XỬ LÝ + GỌI LẠI LLM ĐỂ BẬT NÚT ====================
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            // Lưu tool call
            if (userId) {
                await client.query(
                    `INSERT INTO ChatHistory (conversation_id, user_id, sender, metadata) VALUES ($1,$2,'assistant',$3)`,
                    [convId, userId, { tool_calls: msg.tool_calls }]
                );
            }

            // Thực thi tools
            const toolResults = [];
            for (const tc of msg.tool_calls) {
                const name = tc.function.name;
                const args = JSON.parse(tc.function.arguments);
                let result = "";

                if (name === "get_showtimes_for_movie") result = await get_showtimes_for_movie(args);
                else if (name === "get_movies_at_cinema") result = await get_movies_at_cinema(args.cinema_name, args.date);
                else if (name === "get_movie_details") result = await get_movie_details(args.movie_title);
                else if (name === "get_movie_recommendations_based_on_history") result = userId ? await get_movie_recommendations_based_on_history(userId) : JSON.stringify({ message: "Vui lòng đăng nhập." });
                else if (name === "search_cgv_policies") result = await search_cgv_policies(args);
                else result = JSON.stringify({ error: "Tool không tồn tại" });

                if (userId) {
                    await client.query(
                        `INSERT INTO ChatHistory (conversation_id, user_id, sender, content, metadata) VALUES ($1,$2,'tool',$3,$4)`,
                        [convId, userId, result, { tool_call_id: tc.id, name }]
                    );
                }

                toolResults.push({ role: "tool", tool_call_id: tc.id, name, content: result });
            }

            // GỌI LẦN 2: TỔNG HỢP + BẮT BUỘC GẮN bookingData KHI KHÁCH CHỌN SUẤT
            const finalResponse = await groq.chat.completions.create({
                model: "moonshotai/kimi-k2-instruct-0905",
                messages: [
                    { role: "system", content: getSystemPrompt_Normal(userRow, movies, cities, cinemas) },
                    ...history,
                    { role: "user", content: message },
                    msg,
                    ...toolResults,
                    {
                        role: "system",
                        content: `Bạn là trợ lý CGV siêu dễ thương.
                        Khi khách chọn suất chiếu (ví dụ: "tôi chọn 18:15", "chọn suất 20h", "suất 7 giờ tối"...), 
                        bạn PHẢI trả lời vui vẻ, thêm thật nhiều emoji, in đậm tên phim bằng **, 
                        và CUỐI TIN NHẮN PHẢI GẮN ĐÚNG 1 ĐOẠN JSON SAU (không ghi chú gì thêm):

                        {"bookingData": {"movie_id": 9, "title": "Moana 2", "showtime_id": 12345, "cinema_name": "CGV Vincom Đà Nẵng", "start_time": "2025-11-21 18:15:00", "ticket_price": 110000, "features": ["IMAX"]}}

                        Chỉ gửi đúng 1 bookingData cho suất khách chọn. Không gửi nhiều. Bắt đầu nào!`
                    }
                ],
                temperature: 0.8,
                max_tokens: 1200
            });

            finalReply = finalResponse.choices[0].message.content;

            // Trích xuất bookingData từ JSON trong tin nhắn
            const match = finalReply.match(/\{.*"bookingData".*?\}/s);
            if (match) {
                try {
                    const parsed = JSON.parse(match[0]);
                    bookingDataForFrontend = parsed.bookingData;
                } catch (e) {
                    console.log("Parse bookingData thất bại:", e);
                }
            }

        } else {
            // Không có tool → trả lời trực tiếp
            finalReply = msg.content || "Dạ, bạn cần mình giúp gì ạ?";
        }

        // Làm đẹp tin nhắn
        finalReply = beautifyMovieResponse(finalReply);

        // Lưu reply vào DB
        if (userId) {
            await client.query(
                `INSERT INTO ChatHistory (conversation_id, user_id, sender, content) VALUES ($1,$2,'assistant',$3)`,
                [convId, userId, finalReply]
            );
        }

        await client.query('COMMIT');

        // TRẢ VỀ CHO FRONTEND – bookingData sẽ bật nút đặt vé!
        return res.json({
            reply: finalReply,
            conversation_id: convId,
            bookingData: bookingDataForFrontend
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Lỗi /api/chat:", err);
        return res.status(500).json({ message: "Lỗi server, vui lòng thử lại!" });
    } finally {
        client.release();
    }
});

// === CÁC API KHÁC (Được giữ nguyên) ===
// 1. API gốc
app.get('/', (req, res) => res.send('Backend server CGV đã chạy thành công!'));

// 2. API Đăng ký
app.post('/api/auth/register', async (req, res) => {
    // SỬA: Bổ sung các trường mới từ req.body
    const { name, email, password, phone, birthday, address, gender } = req.body;
    
    if (!name || !email || !password) return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin bắt buộc.' });

    // SỬA: Xử lý giá trị null/undefined cho các trường tùy chọn
    // Nếu giá trị là chuỗi rỗng "", chuyển thành null để DB chấp nhận
    const birthdayValue = birthday ? birthday : null;
    const phoneValue = phone ? phone : null;
    const addressValue = address ? address : null;
    const genderValue = gender ? gender : 'other'; // Đặt 'other' làm mặc định

    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password.trim(), salt);
        
        // SỬA: Cập nhật câu query INSERT
        const newUserQuery = `
            INSERT INTO Users (username, email, password_hash, phone, birthday, address, gender) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) 
            RETURNING user_id, username, email;
        `;
        
        // SỬA: Cập nhật mảng values
        const values = [
            name.trim(), 
            email.trim().toLowerCase(), 
            password_hash,
            phoneValue,
            birthdayValue,
            addressValue,
            genderValue
        ];
        
        const result = await pool.query(newUserQuery, values);
        res.status(201).json({ message: 'Tạo tài khoản thành công!', user: result.rows[0] });
    } catch (err) {
        // Đây là thông báo lỗi chúng ta đã sửa ở bước trước
        if (err.code === '23505') return res.status(400).json({ message: 'Email này đã tồn tại. Vui lòng sử dụng email khác.' });
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});


// 3. API Đăng nhập
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Vui lòng cung cấp email và mật khẩu.' });
    try {
        const userQuery = 'SELECT * FROM Users WHERE email = $1';
        const result = await pool.query(userQuery, [email.trim().toLowerCase()]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Email hoặc mật khẩu không chính xác.' });
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password.trim(), user.password_hash);
        if (!isMatch) return res.status(401).json({ message: 'Email hoặc mật khẩu không chính xác.' });
        const payload = { user: { id: user.user_id, name: user.username, email: user.email } };
        jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' }, (err, token) => {
            if (err) throw err;
            res.status(200).json({ message: 'Đăng nhập thành công!', token: token, user: payload.user });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 4. API Lấy thông tin người dùng
app.get('/api/users/me', authMiddleware, async (req, res) => {
    try {
        const userQuery = 'SELECT user_id, username, email, phone, birthday, address, gender FROM Users WHERE user_id = $1';
        const result = await pool.query(userQuery, [req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy người dùng.' });
        // Format birthday before sending
        const user = result.rows[0];
        if (user.birthday) {
             user.birthday = new Date(user.birthday).toISOString().split('T')[0]; // Format YYYY-MM-DD
        }
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 5. API Cập nhật thông tin người dùng
app.put('/api/users/me', authMiddleware, async (req, res) => {
    const { name, phone, birthday, address, gender } = req.body;
    try {
        const birthdayValue = birthday ? birthday : null; // Handle null birthday
        const updateUserQuery = `
            UPDATE Users 
            SET username = $1, phone = $2, birthday = $3, address = $4, gender = $5 
            WHERE user_id = $6 
            RETURNING user_id, username, email, phone, birthday, address, gender;
        `;
        const values = [name, phone, birthdayValue, address, gender, req.user.id];
        const result = await pool.query(updateUserQuery, values);
        // Format birthday before sending back
        const updatedUser = result.rows[0];
         if (updatedUser.birthday) {
             updatedUser.birthday = new Date(updatedUser.birthday).toISOString().split('T')[0];
         }
        res.json({ message: 'Cập nhật thông tin thành công!', user: updatedUser });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 6. API Lấy lịch sử đặt vé (ĐÃ CẬP NHẬT)
app.get('/api/users/me/bookings', authMiddleware, async (req, res) => {
    try {
        const bookingsQuery = `
            SELECT 
                b.booking_id, 
                m.title AS movie_title, 
                m.poster_url,
                m.genre,
                c.name AS cinema_name, 
                s.start_time, 
                b.total_amount,
                b.seats 
            FROM Bookings b 
            JOIN Showtimes s ON b.showtime_id = s.showtime_id 
            JOIN Movies m ON s.movie_id = m.movie_id
            JOIN Cinemas c ON s.cinema_id = c.cinema_id 
            WHERE b.user_id = $1 
            ORDER BY s.start_time DESC;
        `;
        const result = await pool.query(bookingsQuery, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi API get bookings:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 7. API Lấy danh sách phim (Phiên bản đã sửa lỗi)
app.get('/api/movies', async (req, res) => {
    try {
        const { status } = req.query;
        let query = 'SELECT * FROM Movies ORDER BY release_date DESC';
        
        if (status === 'now-showing') {
            query = "SELECT * FROM Movies WHERE release_date <= CURRENT_DATE ORDER BY release_date DESC";
        } else if (status === 'coming-soon') {
            query = "SELECT * FROM Movies WHERE release_date > CURRENT_DATE ORDER BY release_date ASC";
        }
        
        const result = await pool.query(query);
        // Chuyển đổi định dạng ngày tháng ở phía server trước khi gửi đi
        const movies = result.rows.map(movie => ({
            ...movie,
            // Đảm bảo chỉ chuyển đổi nếu release_date không null
            release_date: movie.release_date ? movie.release_date.toISOString().split('T')[0] : null
        }));

        res.json(movies);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 8. API Lấy danh sách thành phố (Đã sửa để trả về count)
app.get('/api/cinemas/cities', async (req, res) => {
    try {
        const query = 'SELECT city, COUNT(cinema_id)::text as count FROM Cinemas GROUP BY city ORDER BY city'; // Cast count to text
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi API get cities:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 9. API Lấy danh sách rạp phim
app.get('/api/cinemas', async (req, res) => {
    try {
        const { city } = req.query;
        let query = 'SELECT * FROM Cinemas ORDER BY name';
        let values = [];
        if (city && city !== 'all') {
            query = 'SELECT * FROM Cinemas WHERE city = $1 ORDER BY name';
            values.push(city);
        }
        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});


// 11. API để lấy thông tin chi tiết của một phim
app.get('/api/movies/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = "SELECT *, to_char(release_date, 'YYYY-MM-DD') as release_date FROM Movies WHERE movie_id = $1";
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Không tìm thấy phim.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 12. API để lấy suất chiếu của một phim (Đã cập nhật để bao gồm thành phố)
app.get('/api/movies/:id/showtimes', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT 
                s.showtime_id,
                s.start_time,
                s.ticket_price,
                c.name as cinema_name,
                c.city
            FROM Showtimes s
            JOIN Cinemas c ON s.cinema_id = c.cinema_id
            WHERE s.movie_id = $1 AND s.start_time > NOW() 
            ORDER BY c.city, c.name, s.start_time;
        `;
        const result = await pool.query(query, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy suất chiếu cho phim:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});


// 13. API để tạo một booking mới (PHIÊN BẢN CÓ TRANSACTION - ĐÃ SỬA LỖI)
app.post('/api/bookings', authMiddleware, async (req, res) => {
    const { showtime_id, seats } = req.body; // `seats` là một mảng, ví dụ: ['H8', 'H9']
    
    // YÊU CẦU ĐĂNG NHẬP
    if (!req.user) {
        return res.status(401).json({ message: 'Bạn cần đăng nhập để đặt vé.' });
    }
    const userId = req.user.id;

    if (!showtime_id || !seats || !Array.isArray(seats) || seats.length === 0) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin suất chiếu và ghế ngồi.' });
    }

    const client = await pool.connect();

    try {
        // BẮT ĐẦU TRANSACTION
        await client.query('BEGIN');

        // 1. Kiểm tra xem có ghế nào đã được đặt chưa (Sử dụng FOR UPDATE để khóa dòng)
        const checkSeatsQuery = `SELECT seat_id FROM booked_seats WHERE showtime_id = $1 AND seat_id = ANY($2::text[]) FOR UPDATE`;
        const existingSeatsResult = await client.query(checkSeatsQuery, [showtime_id, seats]);

        if (existingSeatsResult.rows.length > 0) {
            const occupied = existingSeatsResult.rows.map(r => r.seat_id).join(', ');
            // SỬA LỖI: Ném lỗi để ROLLBACK và gửi mã lỗi 409
            await client.query('ROLLBACK'); // Hủy transaction
            return res.status(409).json({ message: `Ghế ${occupied} đã có người đặt. Vui lòng chọn ghế khác.` });
        }

        // 2. Lấy giá vé và tính tổng tiền
        const showtimeQuery = 'SELECT ticket_price FROM showtimes WHERE showtime_id = $1';
        const showtimeResult = await client.query(showtimeQuery, [showtime_id]);
        if (showtimeResult.rows.length === 0) {
             // SỬA LỖI: Ném lỗi để ROLLBACK và gửi mã lỗi 404
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Không tìm thấy suất chiếu.' });
        }
        
        // Sửa lỗi tính toán: Dùng giá vé từ DB, *không* dùng hàm logic giá vé cứng ở frontend
        const ticketPrice = parseFloat(showtimeResult.rows[0].ticket_price);
        // Đơn giản hóa: Mọi vé có cùng giá
        const totalAmount = ticketPrice * seats.length; 

        // 3. Tạo một bản ghi mới trong bảng `bookings` với cột `seats`
        const newBookingQuery = `
            INSERT INTO bookings (user_id, showtime_id, total_amount, seats)
            VALUES ($1, $2, $3, $4)
            RETURNING booking_id;
        `;
        const bookingValues = [userId, showtime_id, totalAmount, seats];
        const bookingResult = await client.query(newBookingQuery, bookingValues);
        const newBookingId = bookingResult.rows[0].booking_id;

        // 4. Thêm từng ghế đã đặt vào bảng `booked_seats`
        // (Sử dụng vòng lặp for...of để đảm bảo tuần tự)
        for (const seat_id of seats) {
            const bookSeatQuery = `
                INSERT INTO booked_seats (booking_id, showtime_id, seat_id)
                VALUES ($1, $2, $3);
            `;
            await client.query(bookSeatQuery, [newBookingId, showtime_id, seat_id]);
        }
        
        // 5. Cập nhật lại số ghế trống trong bảng `showtimes`
        const updateShowtimeQuery = `
            UPDATE showtimes 
            SET available_seats = available_seats - $1 
            WHERE showtime_id = $2;
        `;
        await client.query(updateShowtimeQuery, [seats.length, showtime_id]);

        // KẾT THÚC TRANSACTION, LƯU TẤT CẢ THAY ĐỔI
        await client.query('COMMIT');

        res.status(201).json({
            message: 'Đặt vé thành công!',
            bookingId: newBookingId,
        });

    } catch (err) {
        // Nếu có bất kỳ lỗi nào khác (ngoài lỗi đã xử lý ở trên), hủy bỏ tất cả thay đổi
        await client.query('ROLLBACK');
        console.error("Lỗi khi tạo booking:", err);
        // Gửi thông báo lỗi server chung chung
        res.status(500).json({ message: 'Lỗi server khi đặt vé.' });
    } finally {
        // Luôn giải phóng kết nối sau khi hoàn tất
        client.release();
    }
});

// API 15: Lấy danh sách khuyến mãi
app.get('/api/promotions', async (req, res) => {
    try {
        const query = 'SELECT *, to_char(valid_until, \'YYYY-MM-DD\') as valid_until FROM Promotions ORDER BY featured DESC, valid_until ASC';
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy danh sách khuyến mãi:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 16: Lấy danh sách sự kiện (ĐÃ SỬA LỖI)
app.get('/api/events', async (req, res) => {
    try {
        const query = `
            SELECT 
                *, 
                to_char(event_date, 'YYYY-MM-DD') as event_date 
            FROM Events 
            WHERE event_date > NOW() 
            ORDER BY Events.event_date ASC`; 
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy danh sách sự kiện:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 17: Lấy lịch chiếu tổng hợp cho một rạp vào một ngày
app.get('/api/showtimes-by-cinema', async (req, res) => {
    const { cinemaId, date } = req.query; // date có định dạng YYYY-MM-DD

    if (!cinemaId || !date) {
        return res.status(400).json({ message: 'Vui lòng cung cấp cinemaId và date.' });
    }

    try {
        const query = `
            SELECT
                m.movie_id, m.title, m.genre, m.duration_minutes, m.rating, m.age_rating, m.poster_url, m.features,
                json_agg(
                    json_build_object(
                        'showtime_id', s.showtime_id,
                        'start_time', s.start_time,
                        'ticket_price', s.ticket_price
                    ) ORDER BY s.start_time
                ) AS times
            FROM Movies m
            JOIN Showtimes s ON m.movie_id = s.movie_id
            WHERE s.cinema_id = $1 
              AND s.start_time >= ($2::date) 
              AND s.start_time < ($2::date + interval '1 day')
              AND s.start_time > NOW()
            GROUP BY m.movie_id
            ORDER BY m.title;
        `;
        const result = await pool.query(query, [cinemaId, date]);
        res.json(result.rows);
    } catch (err) {
        console.error('Lỗi khi lấy lịch chiếu theo rạp:', err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 18: Lấy danh sách các ghế đã bị chiếm cho một suất chiếu cụ thể
app.get('/api/showtimes/:showtimeId/occupied-seats', async (req, res) => {
    const { showtimeId } = req.params;
    try {
        const query = 'SELECT seat_id FROM booked_seats WHERE showtime_id = $1';
        const result = await pool.query(query, [showtimeId]);
        res.json(result.rows.map(row => row.seat_id));
    } catch (err) {
        console.error('Lỗi khi lấy danh sách ghế đã chiếm:', err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API MỚI: Đặt vé sự kiện
app.post('/api/events/bookings', authMiddleware, async(req, res) => {
     const { event_id, number_of_tickets, total_amount } = req.body;
     
     // YÊU CẦU ĐĂNG NHẬP
     if (!req.user) {
        return res.status(401).json({ message: 'Bạn cần đăng nhập để đặt vé sự kiện.' });
     }
     const userId = req.user.id;

     if (!event_id || !number_of_tickets || number_of_tickets <= 0 || !total_amount) {
         return res.status(400).json({ message: 'Thông tin đặt vé sự kiện không hợp lệ.' });
     }

     const client = await pool.connect();
     try {
         await client.query('BEGIN');

         // Tạo booking sự kiện
         const insertBookingQuery = `
            INSERT INTO event_bookings (user_id, event_id, number_of_tickets, total_amount) 
            VALUES ($1, $2, $3, $4) 
            RETURNING event_booking_id;
         `;
         const bookingResult = await client.query(insertBookingQuery, [userId, event_id, number_of_tickets, total_amount]);
         const newBookingId = bookingResult.rows[0].event_booking_id;

         await client.query('COMMIT');
         res.status(201).json({ message: 'Đặt vé sự kiện thành công!', bookingId: newBookingId });

     } catch (err) {
         await client.query('ROLLBACK');
         console.error("Lỗi khi đặt vé sự kiện:", err);
         res.status(500).json({ message: err.message || 'Lỗi server khi đặt vé sự kiện.' });
     } finally {
         client.release();
     }
});


// Lắng nghe server
app.listen(port, () => {
    console.log(`Server đang chạy tại http://localhost:${port}`);
});