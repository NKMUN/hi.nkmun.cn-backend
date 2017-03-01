const Mailer = require('nodemailer')

module.exports = {
    Mailer: async (ctx, next) => {
        let mailConfig = await ctx.db.collection('meta').findOne({ _id: 'mail' })

        if ( ! mailConfig ) {
            ctx.status = 412
            ctx.body = { error: 'mail config not set' }
        } else {
            // initialize mailer
            let {
                host,
                port,
                account,
                password
            } = mailConfig

            ctx.mailConfig = mailConfig
            ctx.mailer = Mailer.createTransport({
                host,
                port,
                secure: true,
                auth: {
                    user: account,
                    pass: password,
                }
            })

            await next()

            ctx.mailer.close()
        }
    }
}
