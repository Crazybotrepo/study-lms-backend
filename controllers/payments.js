
const mailSender = require('../utils/mailSender');
const { courseEnrollmentEmail } = require('../mail/templates/courseEnrollmentEmail');
require('dotenv').config();

const User = require('../models/user');
const Course = require('../models/course');
const CourseProgress = require("../models/courseProgress")
const { default: mongoose } = require('mongoose')


const paypal = require('@paypal/checkout-server-sdk');
// Инициализация окружения PayPal
const environment = new paypal.core.SandboxEnvironment(
    process.env.PAYPAL_CLIENT_ID, 
    process.env.PAYPAL_CLIENT_SECRET
);
const client = new paypal.core.PayPalHttpClient(environment);

exports.capturePayment = async (req, res) => {
    const { coursesId } = req.body;
    const userId = req.user.id;

    // Проверка наличия ID курса
    if (coursesId.length === 0) {
        return res.json({ success: false, message: "Please provide Course Id" });
    }

    let totalAmount = 0;

    // Обрабатываем каждый курс
    for (const course_id of coursesId) {
        let course;
        try {
            // Ищем курс по ID
            course = await Course.findById(course_id);
            if (!course) {
                return res.status(404).json({ success: false, message: "Could not find the course" });
            }

            // Проверяем, не был ли уже зарегистрирован студент на курс
            const uid = new mongoose.Types.ObjectId(userId);
            if (course.studentsEnrolled.includes(uid)) {
                return res.status(400).json({ success: false, message: "Student is already Enrolled" });
            }

            // Суммируем стоимость курсов
            totalAmount += course.price;
        } catch (error) {
            console.log(error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    
    // Создаем запрос для создания заказа PayPal
    const orderRequest = new paypal.orders.OrdersCreateRequest();
    orderRequest.requestBody({
        intent: 'CAPTURE',  // Указание на захват платежа
        purchase_units: [{
            amount: {
                currency_code: 'USD',  // Ваша валюта (можно использовать другую)
                value: totalAmount.toFixed(2)  // Форматируем сумму с двумя знаками после запятой
            }
        }]
    });

    try {
        // Отправка запроса для создания заказа в PayPal
        const orderResponse = await client.execute(orderRequest);

        // Ответ от PayPal, который будет отправлен на фронтенд
        res.status(200).json({
            success: true,
            message: orderResponse.result,  // Ответ с деталями заказа
            amount: totalAmount  // Сумма, которую нужно оплатить
        });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ success: false, message: "Could not initiate PayPal order" });
    }
};


// ================ verify the payment ================
exports.verifyPayment = async (req, res) => {
    const { id, coursesId } = req.body;
    const userId = req.user.id;

    console.log("Received data for payment verification:", { id, coursesId, userId });

    // Проверка на наличие необходимых данных
    if (!id || !coursesId || !userId) {
        console.log("Missing required data: ", { id, coursesId, userId });
        return res.status(400).json({ success: false, message: "Payment Failed, data not found" });
    }

    try {
        // Пытаемся получить данные о платеже из PayPal
        const request = new paypal.orders.OrdersGetRequest(id);

        const order = await client.execute(request);

        console.log("PayPal order response:", order);

        // Проверяем статус платежа
        if (order.result.status === 'COMPLETED') {
            console.log("Payment succeeded, proceeding with enrollment...");
            // Заказ подтвержден, переходим к записи студентов на курс
            await enrollStudents(coursesId, userId, res);
            return res.status(200).json({ success: true, message: "Payment Verified" });
        } else {
            console.log("Payment failed with status:", order.result.status);
            return res.status(400).json({ success: false, message: "Payment failed" });
        }
    } catch (error) {
        console.error("Error during payment verification:", error);
        return res.status(500).json({ success: false, message: "Payment Verification Failed" });
    }
};



// ================ enroll Students to course after payment ================
const enrollStudents = async (courses, userId, res) => {
    if (!courses || !userId) {
        return res.status(400).json({ success: false, message: "Please Provide data for Courses or UserId" });
    }

    for (const courseId of courses) {
        try {
            const enrolledCourse = await Course.findOneAndUpdate(
                { _id: courseId },
                { $push: { studentsEnrolled: userId } },
                { new: true }
            );

            if (!enrolledCourse) {
                return res.status(500).json({ success: false, message: "Course not Found" });
            }

            const courseProgress = await CourseProgress.create({
                courseID: courseId,
                userId: userId,
                completedVideos: [],
            });

            const enrolledStudent = await User.findByIdAndUpdate(
                userId,
                {
                    $push: {
                        courses: courseId,
                        courseProgress: courseProgress._id,
                    },
                },
                { new: true }
            );

            // Отправляем email пользователю
            const emailResponse = await mailSender(
                enrolledStudent.email,
                `Successfully Enrolled into ${enrolledCourse.courseName}`,
                courseEnrollmentEmail(enrolledCourse.courseName, `${enrolledStudent.firstName}`)
            );
        } catch (error) {
            console.log(error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }
}

// ================ send Payment Success Email ================
exports.sendPaymentSuccessEmail = async (req, res) => {
    const { orderId, paymentId, amount } = req.body;
    const userId = req.user.id;

    if (!orderId || !paymentId || !amount || !userId) {
        return res.status(400).json({ success: false, message: "Please provide all the fields" });
    }

    try {
        const enrolledStudent = await User.findById(userId);
        await mailSender(
            enrolledStudent.email,
            `Payment Received`,
            paymentSuccessEmail(`${enrolledStudent.firstName}`, amount / 100, orderId, paymentId)
        );
    } catch (error) {
        console.log("Error in sending email", error);
        return res.status(500).json({ success: false, message: "Could not send email" });
    }
}
