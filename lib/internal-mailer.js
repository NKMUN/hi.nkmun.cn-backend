const Mailer = require('nodemailer')

module.exports = async function internalMailer(ctx, next) {
    let {
        host,
        port,
        account,
        password
    } = ctx.mailConfig

    const mailer = Mailer.createTransport({
        host,
        port,
        secure: true,
        auth: {
            user: account,
            pass: password,
        }
    })

    ctx.mailer = {
        name: `internal-mailer`,
        sendMail: async ({
            to,
            nickname = ctx.mailConfig.nickname,
            subject,
            html
        }) => {
            try {
                const smtpResult = await mailer.sendMail({
                    from: { name: nickname || account, address: account },
                    to,
                    subject,
                    html,
                })

                ctx.log.smtp = smtpResult
                
                return {
                    success: parseInt(smtpResult.response, 10) == 250,
                    error: null,
                    transportResponse: smtpResult.response
                }
            } catch(e) {
                return {
                    success: false,
                    error: e,
                    transportResponse: null
                }
            }
        }
    }

    await next()

    mailer.close()
}