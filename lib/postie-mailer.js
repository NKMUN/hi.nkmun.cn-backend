const agent = require('superagent')

module.exports = async function postieMailer(ctx, next) {
    if ( ! ctx.POSTIE ) {
        ctx.status = 412
        ctx.body = { error: 'postie mailer configured inproperly' }
        return
    }

    ctx.mailer = {
        name: `postie @ ${ctx.POSTIE}`,
        sendMail: async ({
            to,
            nickname = ctx.mailConfig.nickname,
            subject,
            html
        }) => {
            try {
                const {
                    body
                } = await agent.post(ctx.POSTIE + '/mails/').send({
                    to,
                    nickname,
                    subject,
                    html
                })
                return {
                    success: true,
                    error: null,
                    transportResponse: body
                }
            } catch(e) {
                return {
                    success: false,
                    error: e,
                    transportResponse: e
                }
            }
        }
    }

    if (next)
        await next()
}