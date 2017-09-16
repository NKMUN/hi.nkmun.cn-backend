const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { IsSchoolSelfOr, School } = require('./school')
const { LogOp } = require('../lib/logger')
const { toId, newId } = require('../lib/id-util')
const { readFile, unlink } = require('mz/fs')
const { getBillingDetail } = require('./billing')
const { Mailer } = require('./mailer')
const getPayload = require('./lib/get-payload')

route.post('/schools/:id/payments/',
    IsSchoolSelfOr('finance'),
    LogOp('payment', 'payment'),
    School,
    async ctx => {
       if ( ! ctx.is('multipart') ) {
           ctx.status = 415
           ctx.body = { status: false, message: 'Expect multipart/form-data' }
           return
       }

       let { stage } = ctx.school

       if ( !stage.endsWith('.payment') || Number(stage[0]) >= 3 ) {
          ctx.status = 412
          ctx.body = { error: 'incorrect school stage' }
          return
       }

       let { path, type, size } = ctx.request.body.files.file

       if ( size > 2*1024*1024 ) {
          ctx.status = 400
          ctx.body = { error: 'too large' }
          return
       }

       let {
         insertedId
       } = await ctx.db.collection('payment').insertOne({
          _id: newId(),
          school: ctx.params.id,
          created: new Date(),
          round: stage[0],
          size,
          mime: type,
          buffer: await readFile(path),
       })

       await unlink(path)

       // update stage -> paid
       let nextStage = ctx.school.stage.replace('.payment', '.paid')
       if ( nextStage !== ctx.school.stage ) {
           await ctx.db.collection('school').updateOne(
               { _id: ctx.params.id, stage: ctx.school.stage },
               { $set: { stage: nextStage } }
           )
       } else {
           ctx.status = 412
           ctx.body = { error: 'incorrect school stage' }
           return
       }

       ctx.status = 200
       ctx.body = { id: insertedId }
   }
)

route.patch('/schools/:id/payments/',
    AccessFilter('finance'),
    School,
    LogOp('payment', 'review'),
    Mailer,
    async ctx => {
        if ( ! ctx.school.stage.endsWith('.paid') ) {
            ctx.status = 412
            ctx.body = { error: 'incorrect school stage' }
            return
        }

        let { confirm, reject, reason } = getPayload(ctx)
        if (confirm && reject) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        if (confirm) {
            await LogOp('payment', 'confirm')(ctx)
            await ctx.db.collection('billing').insertOne({
                id: newId(),
                school: ctx.params.id,
                created: new Date(),
                paid_by: ctx.school,
                items: await getBillingDetail(ctx, ctx.params.id, ctx.school.stage[0]),
             })
            await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id },
                { $set: { stage: `${ctx.school.stage[0]}.complete`} }
            )
        }

        if (reject) {
            await LogOp('payment', 'reject')(ctx)
            await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id },
                { $set: { stage: `${ctx.school.stage[0]}.payment`, last_msg: `付款未通过审核：${reason}` } }
            )
        }

        // send mail notification
        let {nickname, account} = ctx.mailConfig
        let mailTemplate

        if (ctx.school.stage[0] === '1') {
            if (confirm)
                mailTemplate = ctx.mailConfig.paymentSuccess
            if (reject)
                mailTemplate = ctx.mailConfig.paymentFailure
        }

        if (ctx.school.stage[0] === '2') {
            if (confirm)
                mailTemplate = ctx.mailConfig.paymentSuccess2
            if (reject)
                mailTemplate = ctx.mailConfig.paymentFailure2
        }

        if (mailTemplate) {
            let mailHtml = String(mailTemplate).replace(/\{([a-zA-Z][a-zA-Z0-9_-]*)\}/g, (m, key) => {
                switch (key) {
                    case 'school': return ctx.school.school.name
                    case 'reason': return reason
                    default:       return ''
                }
            })
            try {
                let smtpResult = await ctx.mailer.sendMail({
                    from: { name: nickname, address: account },
                    to: ctx.school.leader.email,
                    subject: '汇文国际中学生模拟联合国大会缴费审核结果',
                    html: mailHtml
                })
                ctx.log.smtp = smtpResult

                if (parseInt(smtpResult.response) === 250) {
                    ctx.status = 200
                    ctx.body   = { message: smtpResult.response }
                } else {
                    ctx.status = 202
                    ctx.body   = { message: smtpResult.response }
                }
            } catch(e) {
                ctx.status = 202
                ctx.body = { message: e.message }
                throw e
            }
        } else {
            ctx.status = 202
            ctx.body = { message: 'Mail not configured' }
        }
    }
)

route.get('/schools/:id/payments/',
    IsSchoolSelfOr('finance'),
    async ctx => {
        let filter = { school: ctx.params.id }
        if (ctx.query.round)
           filter[round] = String(ctx.query.round)

        ctx.status = 200
        ctx.body = await ctx.db.collection('payment').aggregate([
            { $match: filter },
            { $sort: { created: -1 } },
            { $lookup: {
                from: 'school',
                localField: 'school',
                foreignField: '_id',
                as: 'school'
            } },
            { $unwind: '$school' },
            { $project: {
                _id: false,
                id: '$_id',
                time: '$created',
                round: { $ifNull: ['$round', '1'] },
                school: {
                    id: '$school._id',
                    name: '$school.school.name'
                }
            } }
        ]).toArray()
    }
)

route.get('/schools/:id/payments/:pid',
    IsSchoolSelfOr('finance'),
    async ctx => {
        let payment = await ctx.db.collection('payment').findOne({ _id: ctx.params.pid, school: ctx.params.id })
        if (payment) {
            ctx.status = 200
            ctx.set('Content-Type', payment.mime)
            ctx.set('X-Created-Date', new Date(payment.created).toISOString())
            ctx.body = payment.buffer.buffer    // payment.buffer is Mongodb.Binary
            ctx.status = 200
        } else {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

module.exports = {
    routes: route.routes()
}
